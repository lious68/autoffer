import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsSchema, type Question } from '../src/core/schema';
import { createProviderRouter } from '../src/providers';
import { createVault } from '../src/background/vault';
import { RoutingSettingsSchema } from '../src/core/routing';
import { demoScan } from './helpers';

const q = demoScan().questions[0]!;
const jev = {
  settings: SettingsSchema.parse({ provider: 'typesafe', model: 'jev-latest' }),
  apiKey: 'fake-jev-key',
};
const chat = {
  settings: SettingsSchema.parse({
    provider: 'custom',
    model: 'vision-model',
    baseUrl: 'https://chat.test/v1',
    vision: true,
  }),
  apiKey: 'fake-chat-key',
};
const context = () => ({
  ...jev,
  signal: new AbortController().signal,
  routes: { jev, chat },
});
const jevResult = (confidence = 0.95) => ({
  model: 'jev-test',
  answers: {
    answer: {
      type: 'choice',
      choice: 'o2',
      confidence,
      probabilities: { o1: 0.02, o2: 0.96, o3: 0.02 },
    },
  },
});
const chatResult = (text = false) => ({
  choices: [
    {
      finish_reason: 'stop',
      message: {
        content: JSON.stringify(
          text
            ? { answerText: '参考解答', confidence: 0.9 }
            : { selectedIds: ['o2'], confidence: 0.9 },
        ),
      },
    },
  ],
});
export const imageQuestion: Question = {
  ...q,
  hasVisual: true,
  visuals: [
    {
      id: 'image1',
      fingerprint: 'hash',
      kind: 'image',
      optionId: 'o1',
      x: 10,
      y: 20,
      width: 100,
      height: 60,
      viewportWidth: 1000,
      viewportHeight: 800,
      ready: true,
      obscured: false,
    },
  ],
};

test('plain objective prefers Jev; failures and low confidence each fall back once using the other key', async () => {
  for (const mode of ['good', 'low', 'failed']) {
    const calls: string[] = [];
    const router = createProviderRouter(
      async () => true,
      async (url, init) => {
        const endpoint = String(url);
        calls.push(endpoint);
        assert.equal(
          new Headers(init?.headers).get('Authorization'),
          endpoint.includes('typesafe')
            ? 'Bearer fake-jev-key'
            : 'Bearer fake-chat-key',
        );
        if (endpoint.includes('typesafe'))
          return mode === 'failed'
            ? new Response('secret', { status: 401 })
            : Response.json(jevResult(mode === 'low' ? 0.6 : 0.95));
        return Response.json(chatResult());
      },
    );
    const result = await router.suggest(q, context());
    assert.equal(calls.length, mode === 'good' ? 1 : 2);
    assert.equal(
      result.route?.[0]?.outcome,
      mode === 'failed'
        ? 'failed'
        : mode === 'low'
          ? 'low-confidence'
          : 'success',
    );
    assert.ok(!JSON.stringify(result).includes('fake-jev-key'));
  }
});

test('without Jev all objective questions use chat; subjective and visual questions bypass Jev', async () => {
  for (const kind of ['no-jev', 'text', 'image']) {
    const question =
      kind === 'text'
        ? {
            ...q,
            kind: 'text' as const,
            classification: undefined,
            options: [],
          }
        : kind === 'image'
          ? imageQuestion
          : q;
    let calls = 0;
    const router = createProviderRouter(
      async () => true,
      async (url, init) => {
        calls++;
        assert.equal(url, 'https://chat.test/v1/chat/completions');
        const body = JSON.parse(init?.body as string);
        if (kind === 'image') {
          assert.equal(body.messages[1].content[2].type, 'image_url');
          assert.ok(JSON.stringify(body).includes('image1'));
          assert.ok(!JSON.stringify(body).includes('viewportWidth'));
        }
        return Response.json(chatResult(kind === 'text'));
      },
    );
    const ctx = {
      ...context(),
      ...(kind === 'no-jev' ? { routes: { chat } } : {}),
      captureImages: async () => [
        { id: 'image1', dataUrl: 'data:image/png;base64,AAAA' },
      ],
    };
    const result = await router.suggest(question, ctx);
    assert.equal(calls, 1);
    if (kind === 'text') {
      assert.equal(result.manualOnly, true);
      assert.equal(result.answerText, '参考解答');
    }
  }
});

test('cancellation cannot trigger fallback; absent chat does not invent a route; vision must be enabled', async () => {
  const job = new AbortController();
  let calls = 0;
  const router = createProviderRouter(
    async () => true,
    async () => {
      calls++;
      job.abort();
      throw new Error('network');
    },
  );
  await assert.rejects(
    router.suggest(q, { ...context(), signal: job.signal }),
    /停止/,
  );
  assert.equal(calls, 1);
  const noChat = createProviderRouter(
    async () => true,
    async () => {
      throw new Error('must not fetch');
    },
  );
  await assert.rejects(
    noChat.suggest(
      { ...q, kind: 'text', classification: undefined, options: [] },
      { ...context(), routes: { jev } },
    ),
    /AstraFlow/,
  );
  await assert.rejects(
    noChat.suggest(imageQuestion, {
      ...context(),
      routes: {
        chat: { ...chat, settings: { ...chat.settings, vision: false } },
      },
    }),
    /视觉/,
  );
});

test('dual profiles preserve separate keys, migrate the old active profile and disable Jev independently', async () => {
  const data: Record<string, unknown> = {
    settings: jev.settings,
    apiKeys: { typesafe: 'old' },
  };
  const vault = createVault(
    {
      get: async () => structuredClone(data),
      set: async (value) => {
        Object.assign(data, structuredClone(value));
      },
      remove: async (key) => {
        delete data[key];
      },
    },
    Promise.resolve(),
  );
  assert.equal((await vault.readRoutes!()).credentials.jev?.apiKey, 'old');
  const config = RoutingSettingsSchema.parse({
    jev: jev.settings,
    chat: chat.settings,
    reviewThreshold: 0.85,
    autoAnswer: true,
  });
  await vault.saveRoutes!({ config, chatApiKey: 'new-chat' });
  const both = await vault.readRoutes!();
  assert.equal(both.credentials.jev?.apiKey, 'old');
  assert.equal(both.credentials.chat?.apiKey, 'new-chat');
  assert.equal(both.credentials.chat?.settings.reviewThreshold, 0.85);
  await vault.saveRoutes!({ config: { ...config, jev: null } });
  assert.equal((await vault.readRoutes!()).credentials.jev, undefined);
  await vault.saveRoutes!({
    config: {
      ...config,
      chat: { ...chat.settings, baseUrl: 'https://other.test/v1' },
    },
  });
  assert.equal((await vault.readRoutes!()).credentials.chat, undefined);
  assert.equal((await vault.readRoutes!()).keysPresent?.chat, false);
  assert.equal((await vault.readRoutes!()).credentials.jev?.apiKey, 'old');
});

test('a Jev timeout falls back while the parent run remains active', async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const router = createProviderRouter(
    async () => true,
    async (url, init) => {
      calls++;
      if (String(url).includes('typesafe'))
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      return Response.json(chatResult());
    },
    { jevMs: 5, chatMs: 1000 },
  );
  const result = await router.suggest(q, { ...context(), signal });
  assert.equal(signal.aborted, false);
  assert.equal(calls, 2);
  assert.equal(result.route?.[0]?.outcome, 'failed');
  assert.match(result.route?.[0]?.reason ?? '', /超时/);
  assert.equal(result.route?.[1]?.outcome, 'success');
});
