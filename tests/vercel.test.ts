import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connections } from '../src/core/connections';
import { SettingsSchema } from '../src/core/schema';
import { createJevProvider } from '../src/providers/jev';
import { publicError } from '../src/core/errors';
import { demoScan } from './helpers';

const context = () => ({
  apiKey: 'fake-vercel-key',
  settings: SettingsSchema.parse({
    provider: 'vercel',
    model: 'typesafe-ai/jev',
  }),
  signal: new AbortController().signal,
});

test('Vercel uses its TypeSafe-compatible endpoint, Gateway model ID and Gateway key', async () => {
  let calls = 0;
  const provider = createJevProvider(async (url, init) => {
    calls++;
    assert.equal(url, connections.vercel.endpoint);
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer fake-vercel-key',
    );
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, 'typesafe-ai/jev');
    assert.equal(body.questions.answer.type, 'choice');
    return Response.json({
      model: 'typesafe-ai/jev',
      answers: {
        answer: {
          type: 'choice',
          choice: 'o2',
          probabilities: { o1: 0.1, o2: 0.8, o3: 0.1 },
          confidence: 0.75,
        },
      },
    });
  });
  const result = await provider.suggest(demoScan().questions[0]!, context());
  assert.equal(calls, 1);
  assert.equal(result.provider, 'vercel/jev');
  assert.deepEqual(result.selectedIds, ['o2']);
});

test('Vercel compatibility route preserves noul requests and responses for multiple choice', async () => {
  const provider = createJevProvider(async (_url, init) => {
    const body = JSON.parse(init?.body as string);
    assert.equal(body.questions.o1.type, 'noul');
    return Response.json({
      model: 'typesafe-ai/jev',
      answers: {
        o1: { type: 'noul', noul: 0.9 },
        o2: { type: 'noul', noul: 0.8 },
        o3: { type: 'noul', noul: 0.1 },
      },
    });
  });
  const result = await provider.suggest(
    demoScan().questions.find((item) => item.kind === 'multiple')!,
    context(),
  );
  assert.deepEqual(result.selectedIds, ['o1', 'o2']);
  assert.equal(result.confidence, null);
});

test('Vercel auth and credit errors name the actual destination; no fallback sends its key elsewhere', async () => {
  for (const [status, code] of [
    [401, 'AUTH'],
    [403, 'FORBIDDEN'],
    [402, 'CREDIT'],
    [429, 'RATE_LIMIT'],
  ] as const) {
    let calls = 0;
    const provider = createJevProvider(async (url) => {
      calls++;
      assert.equal(url, connections.vercel.endpoint);
      return new Response('do-not-expose-fake-vercel-key', { status });
    });
    await assert.rejects(
      provider.suggest(demoScan().questions[0]!, context()),
      (error: unknown) => {
        const safe = publicError(error);
        assert.equal(safe.code, code);
        assert.match(safe.message, /Vercel AI Gateway/);
        assert.ok(!safe.message.includes('fake-vercel-key'));
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test('Vercel card verification is not mislabeled as an invalid key; upstream secrets are never displayed', async () => {
  const provider = createJevProvider(async () =>
    Response.json(
      {
        error: {
          type: 'customer_verification_required',
          message: 'fake-vercel-key https://untrusted.test',
        },
      },
      { status: 403 },
    ),
  );
  await assert.rejects(
    provider.suggest(demoScan().questions[0]!, context()),
    (error: unknown) => {
      const safe = publicError(error);
      assert.equal(safe.code, 'BILLING_VERIFICATION');
      assert.match(safe.message, /有效信用卡/);
      assert.ok(!safe.message.includes('fake-vercel-key'));
      assert.ok(!safe.message.includes('untrusted.test'));
      return true;
    },
  );
});

test('channel/model mismatches fail before a network call', async () => {
  let calls = 0;
  const provider = createJevProvider(async () => {
    calls++;
    return Response.json({});
  });
  await assert.rejects(
    provider.suggest(demoScan().questions[0]!, {
      ...context(),
      settings: { ...context().settings, model: 'jev-latest' },
    }),
  );
  assert.equal(calls, 0);
});
