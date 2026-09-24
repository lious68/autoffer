import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PageTools } from '../src/background/page-tools';

test('page tools bind allowed commands to the enabled top-level document and tab', async () => {
  const calls: unknown[] = [];
  const tools = new PageTools({
    executeScript: (async (request: unknown) => {
      calls.push(request);
      return [{ frameId: 0, documentId: 'doc', result: true }];
    }) as typeof chrome.scripting.executeScript,
  });
  const sender = {
    tab: { id: 42 } as chrome.tabs.Tab,
    frameId: 0,
    documentId: 'doc',
  };
  await assert.rejects(tools.request({ type: 'scan', tabId: 9 }, sender));
  await tools.open(42);
  assert.deepEqual(await tools.request({ type: 'scan', tabId: 9 }, sender), {
    type: 'scan',
    tabId: 42,
  });
  await assert.rejects(tools.request({ type: 'settings:get' }, sender));
  await assert.rejects(
    tools.request({ type: 'tools:open', tabId: 42 }, sender),
  );
  await assert.rejects(
    tools.request({ type: 'scan' }, { ...sender, frameId: 1 }),
  );
  await assert.rejects(
    tools.request({ type: 'scan' }, { ...sender, documentId: 'other' }),
  );
  await tools.invalidate(42);
  await assert.rejects(tools.request({ type: 'scan' }, sender));
  assert.equal(calls.length, 2);
});

test('enabled document authorization survives service-worker recreation through session storage', async () => {
  const data: Record<string, unknown> = {};
  const storage = {
    get: async (key: unknown) =>
      key === null ? { ...data } : { [String(key)]: data[String(key)] },
    set: async (values: Record<string, unknown>) => {
      Object.assign(data, values);
    },
    remove: async (key: unknown) => {
      delete data[String(key)];
    },
  } as Pick<typeof chrome.storage.session, 'get' | 'set' | 'remove'>;
  const scripting = {
    executeScript: (async () => [
      { frameId: 0, documentId: 'doc', result: true },
    ]) as typeof chrome.scripting.executeScript,
  };
  await new PageTools(scripting, storage).open(42, false);
  const restored = new PageTools(scripting, storage);
  const sender = {
    tab: { id: 42 } as chrome.tabs.Tab,
    frameId: 0,
    documentId: 'doc',
  };
  assert.deepEqual(await restored.request({ type: 'scan' }, sender), {
    type: 'scan',
    tabId: 42,
  });
  await restored.invalidate(42);
  await assert.rejects(restored.request({ type: 'scan' }, sender));
});

test('report writes are document-bound and saved reports remain available after navigation', async () => {
  const data: Record<string, unknown> = {};
  let navigation = false;
  const storage = {
    get: async (key: unknown) => ({ [String(key)]: data[String(key)] }),
    set: async (values: Record<string, unknown>) => {
      Object.assign(data, values);
    },
    remove: async (key: unknown) => {
      delete data[String(key)];
    },
  } as Pick<typeof chrome.storage.session, 'get' | 'set' | 'remove'>;
  const tools = new PageTools(
    {
      executeScript: (async () => {
        if (navigation) throw new Error('old document');
        return [{ frameId: 0, documentId: 'doc', result: true }];
      }) as typeof chrome.scripting.executeScript,
    },
    storage,
  );
  await tools.open(42);
  const report = {
    startedAt: '2026-09-22T01:00:00Z',
    endedAt: '2026-09-22T01:01:00Z',
    reachedEnd: true,
    dropped: 0,
    records: [],
  };
  const sender = {
    tab: { id: 42 } as chrome.tabs.Tab,
    frameId: 0,
    documentId: 'doc',
  };
  const parsed = await tools.request(
    { type: 'report:save', tabId: 999, report },
    sender,
  );
  assert.equal('tabId' in parsed && parsed.tabId, 42);
  await assert.rejects(
    tools.request(
      { type: 'report:save', report },
      { ...sender, documentId: 'other' },
    ),
  );
  await assert.rejects(tools.request({ type: 'routing:get' }, sender));
  await tools.saveReport(42, report);
  navigation = true;
  assert.deepEqual(await tools.end(42), report);
});

test('reading controls uses only the enabled document and never injects or starts a session', async () => {
  const calls: chrome.scripting.ScriptInjection<unknown[], unknown>[] = [];
  const state = {
    mounted: true,
    started: true,
    running: true,
    ended: false,
    hidden: true,
    atEnd: false,
  };
  const tools = new PageTools({
    executeScript: (async (
      request: chrome.scripting.ScriptInjection<unknown[], unknown>,
    ) => {
      calls.push(request);
      return [
        {
          frameId: 0,
          documentId: 'doc',
          result: calls.length <= 2 ? true : state,
        },
      ];
    }) as typeof chrome.scripting.executeScript,
  });
  assert.equal((await tools.state(42)).started, false);
  assert.equal(calls.length, 0);
  await tools.open(42);
  assert.deepEqual(await tools.state(42), state);
  const read = calls.at(-1)!;
  assert.deepEqual(read.target, { tabId: 42, documentIds: ['doc'] });
  assert.equal(read.files, undefined);
  await assert.rejects(
    tools.request(
      { type: 'tools:state' },
      { tab: { id: 42 } as chrome.tabs.Tab, documentId: 'doc', frameId: 0 },
    ),
  );
});

test('code bridge remains document-bound and rechecks stop after MAIN injection', async () => {
  let running = true,
    stopOnInject = false,
    invoked = 0;
  const tools = new PageTools({
    executeScript: (async (input: {
      files?: string[];
      world?: string;
      target: { tabId: number; documentIds?: string[] };
      args?: unknown[];
      func?: unknown;
    }) => {
      if (input.target.documentIds)
        assert.deepEqual(input.target, { tabId: 42, documentIds: ['doc'] });
      let result: unknown = true;
      if (input.files?.includes('acm-main.js') && stopOnInject) running = false;
      if (input.world === 'ISOLATED' && !input.files && !input.args)
        result = {
          mounted: true,
          hidden: false,
          started: true,
          ended: false,
          running,
          atEnd: false,
        };
      if (input.world === 'MAIN' && input.func) {
        invoked++;
        result = { value: { token: 'ticket', language: 'Python3' } };
      }
      return [{ frameId: 0, documentId: 'doc', result }];
    }) as typeof chrome.scripting.executeScript,
  });
  await tools.open(42);
  const sender = {
    tab: { id: 42 } as chrome.tabs.Tab,
    frameId: 0,
    documentId: 'doc',
  };
  const command = {
    type: 'code:command',
    tabId: 999,
    token: 'ticket',
    action: 'poll',
  };
  assert.equal(
    ((await tools.request(command, sender)) as { tabId: number }).tabId,
    42,
  );
  await assert.rejects(
    tools.request(command, { ...sender, documentId: 'other' }),
  );
  await tools.code(42, { action: 'prepare', questionId: 'nowcoder:acm:1' });
  assert.equal(invoked, 1);
  stopOnInject = true;
  await assert.rejects(
    tools.code(42, { action: 'fill', token: 'ticket', code: 'print(1)' }),
    /已停止/,
  );
  assert.equal(invoked, 1);
});
