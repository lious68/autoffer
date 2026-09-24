import { idleToolState } from '../src/core/tool-state';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { astraFlow } from '../src/core/connections';
import { mountApp } from '../src/ui/app';
import { createVault } from '../src/background/vault';
import { Controller } from '../src/background/controller';
import type { Client } from '../src/core/protocol';

test('dual configuration migrates old Jev settings, authorizes both destinations, preserves keys, and starts/ends only on explicit clicks', async (t) => {
  const dom = new JSDOM('<main id="app"></main>'),
    previous = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => {
    globalThis.document = previous;
    dom.window.close();
  });
  const data: Record<string, unknown> = {
    settings: {
      provider: 'typesafe',
      model: 'jev-latest',
      reviewThreshold: 0.8,
    },
    apiKeys: { typesafe: 'legacy-key' },
  };
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
  const controller = new Controller({
    vault,
    verifyModel: async () => {},
    scan: async () => {
      throw new Error('must not scan while configuring');
    },
    provider: {
      id: 'unused',
      suggest: async () => {
        throw new Error('must not call models');
      },
    },
  });
  const commands: string[] = [];
  let allow = false;
  let runtime = { ...idleToolState };
  const client: Client = {
    activeTabId: async () => 7,
    onPageChange: () => () => {},
    authorizeConnection: async (settings) => {
      assert.equal(settings.baseUrl, astraFlow.baseUrl);
      return allow;
    },
    request: async (request) => {
      commands.push(request.type);
      if (request.type === 'tools:state') return { ...runtime };
      if (request.type === 'tools:stop') {
        runtime.running = false;
        return null;
      }
      if (request.type === 'tools:show') return null;
      if (request.type === 'tools:open') {
        runtime = {
          ...runtime,
          mounted: true,
          started: true,
          running: true,
          ended: false,
        };
        assert.equal(request.autoAnswer, true);
        return null;
      }
      if (request.type === 'tools:end') {
        runtime.running = false;
        runtime.ended = true;
        return {
          report: {
            startedAt: 'start',
            endedAt: 'end',
            reachedEnd: true,
            dropped: 0,
            records: [],
          },
          downloadId: 1,
          filename: 'autoffer-report-end.md',
        };
      }
      return controller.handle(request);
    },
  };
  const unmount = mountApp(document.getElementById('app')!, client);
  t.after(unmount);
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  await settle();
  const runPanel = document.getElementById('panel-run')!;
  const modelsPanel = document.getElementById('panel-models')!;
  assert.equal(runPanel.hidden, false);
  assert.equal(modelsPanel.hidden, true);
  const beforeTab = commands.length;
  document.getElementById('tab-models')!.click();
  assert.equal(modelsPanel.hidden, false);
  assert.equal(runPanel.hidden, true);
  assert.equal(
    commands.length,
    beforeTab,
    'switching views never invokes a model',
  );
  const input = (name: string) =>
    document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  assert.equal(document.querySelector('[name="jev-provider"]'), null);
  assert.equal(input('jev-enabled').checked, true);
  assert.equal(input('chat-enabled').checked, false);
  assert.equal(document.querySelector('[name="chat-provider"]'), null);
  assert.equal(document.body.textContent!.includes('OpenRouter'), false);
  assert.ok(input('chat-enabled').closest('summary'));
  assert.ok(input('jev-enabled').closest('summary'));
  assert.equal(document.body.textContent!.includes('启用此模型'), false);
  const chatCard = input('chat-enabled').closest('details')!;
  chatCard.open = false;
  input('chat-enabled').click();
  assert.equal(chatCard.open, false, 'toggling does not unfold the card');
  await settle();
  assert.equal(
    input('chat-enabled').checked,
    false,
    'an unconfigured model cannot be enabled',
  );
  assert.equal(
    input('chat-key').disabled,
    false,
    'disabled models remain editable',
  );
  assert.equal(input('threshold').value, '80');
  input('threshold').value = '85';
  input('threshold').dispatchEvent(
    new dom.window.Event('input', { bubbles: true }),
  );
  assert.match(input('jev-enabled').closest('summary')!.textContent!, /主要/);
  assert.match(input('chat-enabled').closest('summary')!.textContent!, /辅助/);
  assert.equal(document.body.textContent!.includes('legacy-key'), false);
  input('chat-key').value = 'fake-chat-key';
  input('chat-key').dispatchEvent(
    new dom.window.Event('input', { bubbles: true }),
  );
  await settle();
  assert.equal(input('chat-enabled').checked, false);
  assert.ok(!document.body.textContent!.includes('启用失败'));
  assert.equal(document.querySelector('form'), null);
  input('chat-enabled').click();
  await settle();
  assert.match(document.body.textContent!, /未授予/);
  assert.equal(
    (data.routingConfig as { chatEnabled: boolean }).chatEnabled,
    false,
  );
  assert.equal(input('chat-enabled').checked, false);
  allow = true;
  input('chat-enabled').click();
  await settle();
  const routes = await vault.readRoutes!();
  assert.equal(routes.credentials.jev?.apiKey, 'legacy-key');
  assert.equal(routes.credentials.chat?.apiKey, 'fake-chat-key');
  assert.equal(routes.credentials.chat?.settings.vision, false);
  assert.equal(routes.credentials.chat?.settings.reviewThreshold, 0.8);
  assert.equal(input('chat-key').value, 'fake-chat-key');
  assert.equal(input('jev-key').value, '');
  assert.match(
    document.querySelector('footer')!.textContent!,
    /api.modelverse.cn/,
  );
  assert.equal(
    commands.includes('tools:open'),
    false,
    'opening and saving do not begin paid work',
  );
  const click = (label: string) =>
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent === label)!
      .click();
  document.getElementById('tab-run')!.click();
  assert.equal(
    input('threshold').value,
    '85',
    'switching views preserves edits',
  );
  const firstStart = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === '开始',
  )!;
  firstStart.click();
  firstStart.click();
  await settle();
  assert.equal(commands.filter((c) => c === 'tools:open').length, 1);
  assert.equal((await vault.readRoutes!()).config.reviewThreshold, 0.85);
  assert.equal(runPanel.querySelectorAll('.run-actions button').length, 1);
  assert.equal(runPanel.querySelector('.start-button')!.textContent, '结束');
  click('结束');
  await settle();
  assert.match(document.body.textContent!, /报告已下载/);
  assert.equal(commands.filter((c) => c === 'tools:end').length, 1);
  assert.equal(commands.includes('tools:stop'), false);
  assert.equal(runPanel.querySelector('.start-button')!.textContent, '开始');
  assert.ok(
    ![...runPanel.querySelectorAll('button')].some((b) =>
      /导出|继续|暂停|显示悬浮球/.test(b.textContent!),
    ),
  );
  assert.equal(runPanel.querySelector('.privacy'), null);
  assert.equal(runPanel.textContent!.includes('开始时保存设置'), false);
  const count = commands.length;
  unmount();
  await settle();
  assert.equal(commands.length, count, 'closing popup never cancels the run');
  runtime = { ...runtime, running: true, ended: false };
  const reopen = mountApp(document.getElementById('app')!, client);
  t.after(reopen);
  await settle();
  assert.ok(
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent === '结束',
    ),
    'reopening reads the live page, not a popup-local guess',
  );
  assert.equal(
    commands.filter((c) => c === 'tools:open').length,
    1,
    'reopening never starts another run',
  );
  reopen();
});

test('AstraFlow preset never reuses legacy credentials from a different destination', async (t) => {
  const dom = new JSDOM('<main id="app"></main>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => {
    globalThis.document = previous;
    dom.window.close();
  });
  const data: Record<string, unknown> = {
    routingConfig: {
      jev: null,
      chat: {
        provider: 'openrouter',
        model: 'example/model',
        reviewThreshold: 0.8,
      },
      reviewThreshold: 0.8,
      autoAnswer: true,
    },
    apiKeys: { openrouter: 'fake-legacy-key' },
  };
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
  const client: Client = {
    activeTabId: async () => 1,
    onPageChange: () => () => {},
    authorizeRoutes: async () => true,
    request: async (request) => {
      if (request.type === 'tools:state') return { ...idleToolState };
      if (request.type === 'model:save')
        return vault.saveModel!(request.slot, request.settings, request.apiKey);
      if (request.type === 'model:toggle')
        return vault.toggleModel!(
          request.slot,
          request.enabled,
          undefined,
          async () => {},
        );
      if (request.type === 'routing:get') {
        const { config, keysPresent } = await vault.readRoutes!();
        return {
          ...config,
          hasJevKey: false,
          hasChatKey: keysPresent?.chat ?? false,
        };
      }
      throw new Error('Unexpected request');
    },
  };
  const unmount = mountApp(document.getElementById('app')!, client);
  t.after(unmount);
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const input = (name: string) =>
    document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  await settle();
  assert.equal(document.querySelector('[name="chat-base"]'), null);
  assert.equal(document.querySelector('[name="chat-model"]'), null);
  assert.equal(document.querySelector('[name="chat-vision"]'), null);
  assert.equal(document.querySelector('[name="chat-provider"]'), null);
  assert.equal(input('chat-key').value, '');
  const changed = await vault.readRoutes!();
  assert.equal(changed.config.chat?.provider, 'custom');
  assert.equal(changed.config.chat?.baseUrl, astraFlow.baseUrl);
  assert.equal(changed.config.chat?.model, astraFlow.model);
  assert.equal(changed.keysPresent?.chat, false);
  assert.equal(changed.credentials.chat, undefined);
  assert.equal(changed.config.chatEnabled, false);
  assert.equal(
    (data.apiKeys as { openrouter: string }).openrouter,
    'fake-legacy-key',
  );
});
