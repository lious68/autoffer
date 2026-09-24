import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountApp } from '../src/ui/app';
import { Controller } from '../src/background/controller';
import { createVault } from '../src/background/vault';
import { astraFlow } from '../src/core/connections';
import { SettingsSchema } from '../src/core/schema';
import { idleToolState } from '../src/core/tool-state';
import type { Client, Request } from '../src/core/protocol';

const jev = SettingsSchema.parse({ provider: 'typesafe', model: 'jev-latest' });
const chat = SettingsSchema.parse({
  provider: 'custom',
  baseUrl: astraFlow.baseUrl,
  model: astraFlow.model,
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function storage(initial: Record<string, unknown>) {
  const data = structuredClone(initial);
  const vault = createVault(
    {
      get: async () => structuredClone(data),
      set: async (values) => {
        Object.assign(data, structuredClone(values));
      },
      remove: async (key) => {
        delete data[key];
      },
    },
    Promise.resolve(),
  );
  return { data, vault };
}
function ui(
  t: TestContext,
  options: { chat?: boolean; permission?: () => Promise<boolean> } = {},
) {
  const dom = new JSDOM('<main id="app"></main>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  const store = storage({
    routingConfig: {
      jev,
      chat: options.chat ? chat : null,
      jevEnabled: true,
      chatEnabled: Boolean(options.chat),
      reviewThreshold: 0.8,
      autoAnswer: true,
    },
    apiKeys: {
      typesafe: 'fake-jev-key',
      custom: options.chat ? { [astraFlow.baseUrl]: 'fake-chat-key' } : {},
    },
  });
  let probes = 0;
  let permissions = 0;
  const controller = new Controller({
    vault: store.vault,
    verifyModel: async () => {
      probes++;
    },
    hasPermission: async () => true,
    scan: async () => {
      throw new Error('No scan during configuration');
    },
    provider: {
      id: 'unused',
      suggest: async () => {
        throw new Error('No model requests during configuration');
      },
    },
  });
  const requests: Request[] = [];
  const client: Client = {
    activeTabId: async () => 1,
    onPageChange: () => () => {},
    authorizeConnection: async () => {
      permissions++;
      return options.permission ? options.permission() : true;
    },
    request: async (request) => {
      requests.push(request);
      if (request.type === 'tools:state') return { ...idleToolState };
      if (request.type === 'tools:open') return null;
      return controller.handle(request);
    },
  };
  const unmount = mountApp(document.getElementById('app')!, client);
  t.after(() => {
    unmount();
    dom.window.close();
    globalThis.document = previous;
  });
  const input = (name: string) =>
    document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  const fill = (name: string, value: string) => {
    input(name).value = value;
    input(name).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  return {
    ...store,
    requests,
    input,
    fill,
    probes: () => probes,
    permissions: () => permissions,
    client,
    unmount,
  };
}

test('disable retains profile and key, removes inference credentials, and can re-enable the same destination', async () => {
  const { vault } = storage({
    routingConfig: { jev, chat },
    apiKeys: {
      typesafe: 'fake-jev',
      custom: { [astraFlow.baseUrl]: 'fake-chat' },
    },
  });
  await vault.toggleModel!('chat', false);
  let state = await vault.readRoutes!();
  assert.deepEqual(state.config.chat, chat);
  assert.equal(state.config.chatEnabled, false);
  assert.equal(state.keysPresent?.chat, true);
  assert.equal(state.credentials.chat, undefined);
  assert.ok(state.credentials.jev);
  await assert.rejects(
    vault.toggleModel!('chat', true, async () => false),
    /权限/,
  );
  assert.equal((await vault.readRoutes!()).config.chatEnabled, false);
  await vault.toggleModel!(
    'chat',
    true,
    async () => true,
    async () => {},
  );
  assert.equal(
    (await vault.readRoutes!()).credentials.chat?.apiKey,
    'fake-chat',
  );
  await vault.removeModelKey!('chat');
  state = await vault.readRoutes!();
  assert.deepEqual(state.config.chat, chat);
  assert.equal(state.config.chatEnabled, false);
  assert.equal(state.keysPresent?.chat, false);
  await assert.rejects(vault.toggleModel!('chat', true), /API Key/);
});

test('model edits are isolated, initially inactive, and concurrent operations preserve the other model', async () => {
  const { vault } = storage({
    routingConfig: { jev, chat },
    apiKeys: {
      typesafe: 'fake-jev',
      custom: { [astraFlow.baseUrl]: 'fake-chat' },
    },
  });
  await Promise.all([
    vault.saveModel!('chat', { ...chat, model: 'replacement' }),
    vault.toggleModel!('jev', false),
    vault.savePreferences!(0.9, false),
  ]);
  const state = await vault.readRoutes!();
  assert.equal(state.config.chat?.model, 'replacement');
  assert.equal(state.config.chatEnabled, false);
  assert.equal(state.config.jevEnabled, false);
  assert.equal(state.config.reviewThreshold, 0.9);
  assert.equal(state.config.autoAnswer, false);
  assert.deepEqual(state.credentials, {});
  await assert.rejects(vault.saveModel!('chat', jev));
  assert.equal((await vault.readRoutes!()).config.chat?.model, 'replacement');
});

test('editing auto-saves without permission or probe requests; only a manual toggle enables the model', async (t) => {
  const f = ui(t, { chat: true });
  await settle();
  f.input('chat-enabled').click();
  await settle();
  assert.equal((await f.vault.readRoutes!()).config.chatEnabled, false);
  const body = f.input('chat-key').closest('fieldset')!;
  assert.equal(body.disabled, false);
  assert.equal(body.hidden, false);
  f.fill('chat-key', 'updated-key');
  await settle();
  const state = await f.vault.readRoutes!();
  assert.equal(state.config.chatEnabled, false);
  assert.equal(state.config.chat?.model, astraFlow.model);
  assert.equal(f.probes(), 0);
  assert.equal(f.permissions(), 0);
  assert.ok(
    !f
      .input('chat-enabled')
      .closest('summary')!
      .textContent!.includes('待保存'),
  );
  assert.equal(f.input('chat-enabled').checked, false);
  assert.ok(
    ![...document.querySelectorAll('button')].some((b) =>
      b.textContent?.includes('保存'),
    ),
  );
  f.input('chat-enabled').click();
  await settle();
  assert.equal(
    (await f.vault.readRoutes!()).credentials.chat?.apiKey,
    'updated-key',
  );
  assert.equal(f.probes(), 1);
  assert.equal(f.input('chat-enabled').checked, true);
  assert.ok(!f.requests.some((r) => r.type === 'tools:open'));
  assert.equal(f.requests.filter((r) => r.type === 'model:save').length, 1);
});

test('an invalid key is saved as a draft but does not block another enabled model', async (t) => {
  const f = ui(t, { chat: true });
  await settle();
  f.fill('chat-key', 'invalid key with spaces');
  await settle();
  assert.equal(f.probes(), 0);
  assert.equal(f.permissions(), 0);
  f.input('chat-enabled').click();
  await settle();
  assert.equal((await f.vault.readRoutes!()).config.chatEnabled, false);
  assert.match(document.body.textContent!, /API Key/);
  [...document.querySelectorAll('button')]
    .find((b) => b.textContent === '开始')!
    .click();
  await settle();
  assert.equal(f.requests.filter((r) => r.type === 'tools:open').length, 1);
  assert.equal(f.input('chat-key').value, 'invalid key with spaces');
});

test('missing key saves the profile, keeps it disabled, and shows an activation warning', async (t) => {
  const f = ui(t);
  await settle();
  await settle();
  const state = await f.vault.readRoutes!();
  assert.equal(state.config.chat?.baseUrl, astraFlow.baseUrl);
  assert.equal(state.config.chatEnabled, false);
  assert.equal(f.input('chat-enabled').checked, false);
  assert.ok(!document.body.textContent!.includes('启用失败'));
  f.input('chat-enabled').click();
  await settle();
  assert.match(document.body.textContent!, /验证失败/);
  assert.match(document.body.textContent!, /API Key/);
});

test('closing during manual activation wins over delayed permission and later autosaved edits', async (t) => {
  let resolvePermission!: (allowed: boolean) => void;
  const f = ui(t, {
    chat: true,
    permission: () =>
      new Promise((resolve) => {
        resolvePermission = resolve;
      }),
  });
  await settle();
  f.fill('chat-key', 'saved-key');
  await settle();
  f.input('chat-enabled').click();
  await settle();
  assert.equal(f.input('chat-enabled').checked, true);
  f.input('chat-enabled').click();
  f.fill('chat-key', 'new-unsaved-key');
  await settle();
  assert.equal((await f.vault.readRoutes!()).config.chatEnabled, false);
  resolvePermission(true);
  await settle();
  assert.equal((await f.vault.readRoutes!()).config.chatEnabled, false);
  assert.equal(f.input('chat-enabled').checked, false);
  assert.equal(f.input('chat-key').value, 'new-unsaved-key');
  assert.ok(!f.requests.some((r) => r.type === 'model:toggle' && r.enabled));
});

test('a disable queued behind an in-flight enable remains the final persisted state', async () => {
  const { vault } = storage({
    routingConfig: { jev, chat, chatEnabled: false },
    apiKeys: { custom: { [astraFlow.baseUrl]: 'fake-chat' } },
  });
  let release!: (allowed: boolean) => void;
  const enabling = vault.toggleModel!(
    'chat',
    true,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await settle();
  const disabling = vault.toggleModel!('chat', false);
  const cancelled = assert.rejects(enabling, /取消/);
  await disabling;
  release(true);
  await cancelled;
  assert.equal((await vault.readRoutes!()).config.chatEnabled, false);
  assert.equal((await vault.readRoutes!()).credentials.chat, undefined);
});

test('rapid edits including reverting to the original value persist in order without validation', async (t) => {
  const f = ui(t, { chat: true });
  await settle();
  f.fill('chat-key', 'temporary-key');
  f.fill('chat-key', 'fake-chat-key');
  await settle();
  assert.equal(
    (f.data.apiKeys as { custom: Record<string, string> }).custom[
      astraFlow.baseUrl
    ],
    'fake-chat-key',
  );
  assert.equal((await f.vault.readRoutes!()).config.chatEnabled, false);
  assert.equal(f.probes(), 0);
  assert.equal(f.permissions(), 0);
});

test('the last edit is sent before the popup closes, including invalid drafts', async (t) => {
  const f = ui(t, { chat: true });
  await settle();
  f.fill('chat-key', 'unfinished key');
  f.unmount();
  await settle();
  assert.equal(
    (f.data.apiKeys as { custom: Record<string, string> }).custom[
      astraFlow.baseUrl
    ],
    'unfinished key',
  );
  assert.equal((await f.vault.readRoutes!()).config.chatEnabled, false);
  assert.equal(f.probes(), 0);
});

test('manual activation waits for the latest autosaved key and tests exactly once', async (t) => {
  const f = ui(t);
  await settle();
  f.fill('chat-key', 'fake-latest-key');
  f.input('chat-enabled').click();
  await settle();
  const state = await f.vault.readRoutes!();
  assert.equal(state.config.chatEnabled, true);
  assert.equal(state.credentials.chat?.settings.model, astraFlow.model);
  assert.equal(state.credentials.chat?.apiKey, 'fake-latest-key');
  assert.equal(f.probes(), 1);
  assert.equal(f.permissions(), 1);
});

test('both fixed model cards accept only a key and confirm enables after saving the latest input', async (t) => {
  const f = ui(t);
  await settle();
  for (const slot of ['jev', 'chat'] as const) {
    const card = f.input(`${slot}-key`).closest('details')!;
    card.open = true;
    assert.equal(card.querySelectorAll('fieldset input').length, 1);
    assert.equal(card.querySelector('select'), null);
    assert.ok(!card.textContent!.includes('删除此 Key'));
    const confirm = card.querySelector<HTMLButtonElement>(
      `[name="${slot}-confirm"]`,
    )!;
    f.fill(`${slot}-key`, `fake-${slot}-confirmed-key`);
    const before = f.probes();
    confirm.click();
    confirm.click();
    await settle();
    const state = await f.vault.readRoutes!();
    assert.equal(state.config[`${slot}Enabled`], true);
    assert.equal(state.credentials[slot]?.apiKey, `fake-${slot}-confirmed-key`);
    assert.equal(
      state.credentials[slot]?.settings.model,
      slot === 'jev' ? 'jev-latest' : astraFlow.model,
    );
    assert.equal(
      state.credentials[slot]?.settings.provider,
      slot === 'jev' ? 'typesafe' : 'custom',
    );
    assert.equal(f.probes(), before + 1);
    assert.equal(confirm.disabled, false);
    assert.equal(confirm.textContent, '确认');
    assert.equal(card.open, false, 'successful verification folds the card');
  }
});

test('a failed verification appears once and survives remounting the side panel', async (t) => {
  const f = ui(t);
  await settle();
  await settle();
  f.input('chat-enabled').click();
  await settle();
  const state = await f.vault.readRoutes!();
  assert.equal(state.modelStates?.chat?.phase, 'failed');
  assert.equal(f.input('chat-key').closest('details')!.open, true);
  const message = state.modelStates!.chat!.message!;
  assert.equal(document.body.textContent!.split(message).length - 1, 1);
  assert.equal(document.querySelector('.status')!.textContent, '');
  f.unmount();
  const again = mountApp(document.getElementById('app')!, f.client);
  t.after(again);
  await settle();
  assert.equal(document.body.textContent!.split(message).length - 1, 1);
  assert.equal(f.input('chat-enabled').checked, false);
  assert.match(document.body.textContent!, /deepseek-v4\.1-flash/);
});

test('the remembered model view restores without revalidating or changing the draft', async (t) => {
  const f = ui(t, { chat: true });
  await settle();
  let selected: 'run' | 'models' = 'models';
  f.client.getPanelView = async () => selected;
  f.client.setPanelView = async (value) => {
    selected = value;
  };
  f.unmount();
  const again = mountApp(document.getElementById('app')!, f.client);
  t.after(again);
  await settle();
  assert.equal(document.getElementById('panel-models')!.hidden, false);
  document.getElementById('tab-run')!.click();
  assert.equal(selected, 'run');
  assert.equal(f.probes(), 0);
});

test('AstraFlow only needs a key and uses the fixed model and endpoint', async (t) => {
  const f = ui(t);
  await settle();
  const state = await f.vault.readRoutes!();
  assert.equal(state.config.chat?.baseUrl, 'https://api.modelverse.cn/v1');
  assert.equal(state.config.chat?.model, 'deepseek-v4.1-flash');
  assert.equal(state.config.chat?.vision, false);
  assert.equal(state.config.chatEnabled, false);
  assert.equal(f.permissions(), 0);
  assert.equal(f.probes(), 0);
  const card = f.input('chat-key').closest('details')!;
  assert.equal(card.querySelectorAll('fieldset input').length, 1);
  assert.equal(card.querySelector('select'), null);
  assert.match(card.textContent!, /deepseek-v4\.1-flash/);
});

test('Enter confirms the key; closing the switch while confirmation awaits permission cancels activation', async (t) => {
  let release!: (allowed: boolean) => void;
  const f = ui(t, {
    permission: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await settle();
  f.fill('chat-key', 'fake-enter-key');
  f.input('chat-key').dispatchEvent(
    new document.defaultView!.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
    }),
  );
  await settle();
  const confirm = document.querySelector<HTMLButtonElement>(
    '[name="chat-confirm"]',
  )!;
  assert.equal(confirm.disabled, true);
  assert.equal(f.input('chat-enabled').checked, true);
  f.input('chat-enabled').click();
  await settle();
  release(true);
  await settle();
  assert.equal(f.probes(), 0);
  assert.equal((await f.vault.readRoutes!()).config.chatEnabled, false);
  assert.equal(confirm.disabled, false);
});
