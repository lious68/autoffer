import { test } from 'node:test';
import assert from 'node:assert/strict';
import { astraFlow } from '../src/core/connections';
import { createModelVerifier } from '../src/providers/verify';
import { createVault } from '../src/background/vault';
import { Controller } from '../src/background/controller';
import { SettingsSchema, type SettingsDraft } from '../src/core/schema';
import { parseRequest } from '../src/core/protocol';

const chat = SettingsSchema.parse({
  provider: 'custom',
  model: 'test-model',
  baseUrl: 'https://model.example.test/v1',
});
const ok = () =>
  Response.json({
    choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
  });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function setup(fetcher: typeof fetch = async () => ok()) {
  const data: Record<string, unknown> = {};
  const storage = {
    get: async () => structuredClone(data),
    set: async (values: Record<string, unknown>) => {
      Object.assign(data, structuredClone(values));
    },
    remove: async (key: string) => {
      delete data[key];
    },
  };
  const vault = createVault(storage, Promise.resolve());
  const controller = new Controller({
    vault,
    hasPermission: async () => true,
    verifyModel: createModelVerifier(fetcher),
    scan: async () => {
      throw new Error('No page reads during verification');
    },
    provider: {
      id: 'unused',
      suggest: async () => {
        throw new Error('No inference routing or fallback');
      },
    },
  });
  return {
    data,
    vault,
    controller,
    reopen: () => createVault(storage, Promise.resolve()),
  };
}

test('invalid model, URL and key are saved and reloadable; activation alone validates them', async () => {
  let calls = 0;
  const f = setup(async () => {
    calls++;
    return ok();
  });
  for (const [patch, key, expected] of [
    [{ model: '' }, 'fake-key', /模型名称/],
    [{ baseUrl: 'unfinished-address' }, 'fake-key', /Base URL/],
    [{}, 'Bearer invalid key', /API Key 格式/],
  ] as const) {
    const draft: SettingsDraft = { ...chat, ...patch };
    const request = parseRequest({
      type: 'model:save',
      slot: 'chat',
      settings: draft,
      apiKey: key,
    });
    await f.controller.handle(request);
    const reopened = await f.reopen().readRoutes!();
    assert.deepEqual(reopened.config.chat, draft);
    assert.equal(reopened.config.chatEnabled, false);
    assert.equal(reopened.keysPresent?.chat, true);
    assert.equal(reopened.credentials.chat, undefined);
    await assert.rejects(
      f.controller.handle({
        type: 'model:toggle',
        slot: 'chat',
        enabled: true,
      }),
      expected,
    );
    assert.equal(calls, 0);
    await f.controller.handle({
      type: 'model:toggle',
      slot: 'chat',
      enabled: false,
    });
    await f.controller.handle({
      type: 'routing:preferences',
      reviewThreshold: 0.9,
      autoAnswer: false,
    });
  }
});

test('draft keys remain scoped to the exact destination when an invalid URL is corrected', async () => {
  const f = setup();
  await f.vault.saveModel!(
    'chat',
    { ...chat, baseUrl: 'unfinished' },
    'fake-draft-key',
  );
  await f.vault.saveModel!('chat', chat);
  assert.equal((await f.vault.readRoutes!()).keysPresent?.chat, false);
  await f.vault.saveModel!('chat', { ...chat, baseUrl: 'unfinished' });
  assert.equal((await f.vault.readRoutes!()).keysPresent?.chat, true);
  await f.vault.removeModelKey!('chat');
  assert.equal((await f.vault.readRoutes!()).keysPresent?.chat, false);
});

test('chat activation makes exactly one minimal request and enables only after a valid completion', async () => {
  let calls = 0;
  const f = setup(async (url, init) => {
    calls++;
    assert.equal(url, 'https://model.example.test/v1/chat/completions');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer fake-key',
    );
    assert.deepEqual(JSON.parse(init!.body as string), {
      model: 'test-model',
      stream: false,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Reply OK.' }],
    });
    assert.equal((await f.vault.readRoutes!()).config.chatEnabled, false);
    return ok();
  });
  await f.controller.handle({
    type: 'model:save',
    slot: 'chat',
    settings: chat,
    apiKey: 'fake-key',
  });
  assert.equal(calls, 0);
  await f.controller.handle({
    type: 'model:toggle',
    slot: 'chat',
    enabled: true,
  });
  assert.equal(calls, 1);
  assert.equal((await f.vault.readRoutes!()).config.chatEnabled, true);
});

test('Jev channels probe their own endpoint with a single small decision instead of using Chat', async () => {
  for (const [provider, model, endpoint] of [
    ['typesafe', 'jev-latest', 'https://api.typesafe.ai/v1/systemone'],
    [
      'vercel',
      'typesafe-ai/jev',
      'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
    ],
    ['jev-agent', 'jev-latest', 'https://jev-agent.com/api/v1/systemone'],
  ] as const) {
    let calls = 0;
    const verify = createModelVerifier(async (url, init) => {
      calls++;
      assert.equal(url, endpoint);
      assert.equal(
        new Headers(init?.headers).get('Authorization'),
        `Bearer fake-${provider}`,
      );
      const body = JSON.parse(init!.body as string);
      assert.equal(body.model, model);
      assert.deepEqual(Object.keys(body.questions), ['ping']);
      assert.equal(body.questions.ping.type, 'noul');
      assert.deepEqual(
        provider === 'jev-agent' ? JSON.parse(body.state) : body.state,
        { ping: true },
      );
      assert.ok((init!.body as string).length < 400);
      return Response.json({ answers: { ping: { type: 'noul', noul: 0.99 } } });
    });
    await verify(
      {
        settings: SettingsSchema.parse({ provider, model }),
        apiKey: `fake-${provider}`,
      },
      new AbortController().signal,
    );
    assert.equal(calls, 1);
  }
});

test('authentication, server errors and malformed completions leave the saved configuration disabled', async () => {
  for (const response of [
    () =>
      Response.json(
        { error: { message: 'PRIVATE_SENTINEL' } },
        { status: 401 },
      ),
    () =>
      Response.json(
        { error: { message: 'PRIVATE_SENTINEL' } },
        { status: 500 },
      ),
    () => Response.json({ choices: [] }),
    () =>
      Response.json({
        choices: [{ finish_reason: 'stop', message: { content: null } }],
      }),
    () => new Response('PRIVATE_SENTINEL'),
    () => new Response('x'.repeat(66000)),
  ]) {
    let calls = 0;
    const f = setup(async () => {
      calls++;
      return response();
    });
    await f.vault.saveModel!('chat', chat, 'fake-key');
    await assert.rejects(
      f.controller.handle({
        type: 'model:toggle',
        slot: 'chat',
        enabled: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('PRIVATE_SENTINEL'));
        return true;
      },
    );
    assert.equal(calls, 1, 'there is no retry or fallback');
    const state = await f.vault.readRoutes!();
    assert.deepEqual(state.config.chat, chat);
    assert.equal(state.config.chatEnabled, false);
    assert.equal(state.keysPresent?.chat, true);
  }
});

test('verification timeout is bounded and distinct from manual cancellation', async () => {
  const verify = createModelVerifier(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        );
      }),
    5,
  );
  await assert.rejects(
    verify(
      { settings: chat, apiKey: 'fake-key' },
      new AbortController().signal,
    ),
    /超时/,
  );
  let calls = 0;
  await assert.rejects(
    createModelVerifier(async () => {
      calls++;
      return ok();
    })({ settings: chat, apiKey: 'fake-key' }, AbortSignal.abort()),
    /取消/,
  );
  assert.equal(calls, 0);
});

test('disable and a new save cancel probes without waiting, and ignore successful late responses', async () => {
  for (const action of ['disable', 'save'] as const) {
    let resolve!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const f = setup(async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((r) => {
        resolve = r;
      });
    });
    await f.vault.saveModel!('chat', chat, 'fake-key');
    const pending = f.controller.handle({
      type: 'model:toggle',
      slot: 'chat',
      enabled: true,
    });
    const cancelled = assert.rejects(pending, /取消/);
    await settle();
    if (action === 'disable')
      await f.controller.handle({
        type: 'model:toggle',
        slot: 'chat',
        enabled: false,
      });
    else
      await f.controller.handle({
        type: 'model:save',
        slot: 'chat',
        settings: { ...chat, model: 'replacement' },
      });
    assert.equal(signal?.aborted, true);
    assert.equal((await f.vault.readRoutes!()).config.chatEnabled, false);
    resolve(ok());
    await cancelled;
    assert.equal((await f.vault.readRoutes!()).config.chatEnabled, false);
  }
});

test('AstraFlow verification disables thinking with a bounded answer budget and no retry', async () => {
  let calls = 0;
  const verify = createModelVerifier(async (url, init) => {
    calls++;
    assert.equal(url, astraFlow.baseUrl + '/chat/completions');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, astraFlow.model);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_tokens, 64);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'Reply OK.' }]);
    return ok();
  });
  await verify(
    {
      settings: { ...chat, baseUrl: astraFlow.baseUrl, model: astraFlow.model },
      apiKey: 'fake-key',
    },
    new AbortController().signal,
  );
  assert.equal(calls, 1);
});

test('truncation, reasoning-only output, refusals and empty content are distinct failures, never enabled or echoed', async () => {
  for (const [finish_reason, content, reasoning_content, refusal, expected] of [
    ['length', null, 'PRIVATE_SENTINEL', null, /token 上限/],
    ['length', 'O', null, null, /token 上限/],
    ['stop', null, 'PRIVATE_SENTINEL', null, /只返回了思考内容/],
    ['stop', '', null, null, /空正文/],
    ['stop', 'OK', null, 'PRIVATE_SENTINEL', /拒绝/],
    ['content_filter', null, null, null, /拒绝/],
    ['tool_calls', null, null, null, /工具调用/],
  ] as const) {
    let calls = 0;
    const f = setup(async () => {
      calls++;
      return Response.json({
        choices: [
          { finish_reason, message: { content, reasoning_content, refusal } },
        ],
      });
    });
    await f.vault.saveModel!('chat', chat, 'fake-key');
    await assert.rejects(
      f.controller.handle({
        type: 'model:toggle',
        slot: 'chat',
        enabled: true,
      }),
      expected,
    );
    const state = await f.vault.readRoutes!();
    assert.equal(state.config.chatEnabled, false);
    assert.equal(state.modelStates?.chat?.phase, 'failed');
    assert.ok(!state.modelStates?.chat?.message?.includes('PRIVATE_SENTINEL'));
    assert.equal(calls, 1);
  }
});
