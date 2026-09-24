import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { isTrustedUiSender } from '../src/background/ui-sender';
import { createVault } from '../src/background/vault';
import { SettingsSchema } from '../src/core/schema';
import { AppError } from '../src/core/errors';

const id = 'test-extension';
const panelUrl = `chrome-extension://${id}/popup.html`;
test('only the extension popup main document gets privileged UI access, even with sender.tab', () => {
  for (const tab of [undefined, { id: 1 }]) {
    const sender = {
      id,
      url: panelUrl,
      ...(tab ? { tab: tab as chrome.tabs.Tab } : {}),
    };
    assert.equal(isTrustedUiSender(sender, id, panelUrl), true);
    assert.equal(
      isTrustedUiSender({ ...sender, id: 'other-extension' }, id, panelUrl),
      false,
    );
    assert.equal(
      isTrustedUiSender({ ...sender, frameId: 1 }, id, panelUrl),
      false,
    );
    for (const url of [
      'https://example.test/popup.html',
      panelUrl + '?source=web',
      `chrome-extension://${id}/sidepanel.html`,
      `chrome-extension://${id}/untrusted.html`,
    ])
      assert.equal(isTrustedUiSender({ ...sender, url }, id, panelUrl), false);
  }
});

test('package opens the compact popup without a side panel or options page', () => {
  const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8'));
  assert.equal(manifest.side_panel, undefined);
  assert.ok(!manifest.permissions.includes('sidePanel'));
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.options_page, undefined);
  assert.equal(manifest.options_ui, undefined);
  assert.equal(existsSync('public/sidepanel.html'), false);
  assert.match(readFileSync('public/popup.html', 'utf8'), /popup\.js/);
});

const settings = SettingsSchema.parse({
  provider: 'custom',
  model: 'example',
  baseUrl: 'https://model.example.test/v1',
});
function setup(data: Record<string, unknown> = {}) {
  const store = {
    get: async () => structuredClone(data),
    set: async (values: Record<string, unknown>) => {
      Object.assign(data, structuredClone(values));
    },
    remove: async (key: string) => {
      delete data[key];
    },
  };
  return {
    vault: createVault(store, Promise.resolve()),
    reopen: () => createVault(store, Promise.resolve()),
    data,
  };
}

test('verification result persists after UI closure, while new edits clear the old error', async () => {
  const f = setup();
  await f.vault.saveModel!('chat', settings, 'fake-key');
  await assert.rejects(
    f.vault.toggleModel!(
      'chat',
      true,
      async () => true,
      async () => {
        throw new AppError('AUTH', '鉴权失败，请检查 Key。');
      },
    ),
    /鉴权失败/,
  );
  const reopened = await f.reopen().readRoutes!();
  assert.equal(reopened.modelStates?.chat?.phase, 'failed');
  assert.equal(reopened.modelStates?.chat?.message, '鉴权失败，请检查 Key。');
  assert.ok(!JSON.stringify(reopened.modelStates).includes('fake-key'));
  await f.vault.saveModel!('chat', { ...settings, model: 'new-model' });
  assert.equal((await f.vault.readRoutes!()).modelStates?.chat?.phase, 'idle');
  await f.vault.toggleModel!(
    'chat',
    true,
    async () => true,
    async () => {},
  );
  assert.equal(
    (await f.reopen().readRoutes!()).modelStates?.chat?.phase,
    'enabled',
  );
});

test('a worker restart changes abandoned checking state to an actionable failure', async () => {
  const f = setup({
    routingConfig: { jev: null, chat: settings, chatEnabled: false },
    apiKeys: { custom: { 'https://model.example.test/v1': 'fake-key' } },
    modelStates: {
      chat: { phase: 'checking', updatedAt: '2026-09-23T00:00:00Z' },
    },
  });
  const state = await f.vault.readRoutes!();
  assert.equal(state.modelStates?.chat?.phase, 'failed');
  assert.match(state.modelStates!.chat!.message!, /验证已中断/);
  assert.equal(state.config.chatEnabled, false);
});
