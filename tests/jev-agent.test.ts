import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRouter } from '../src/providers';
import { createJevProvider } from '../src/providers/jev';
import { SettingsSchema } from '../src/core/schema';
import { publicError } from '../src/core/errors';
import { demoScan } from './helpers';

const context = () => ({
  apiKey: 'fake-jev-agent-key',
  settings: SettingsSchema.parse({
    provider: 'jev-agent',
    model: 'jev-latest',
  }),
  signal: new AbortController().signal,
});
const singleResponse = {
  model: 'jev-1.13.0',
  answers: {
    answer: {
      type: 'choice',
      choice: 'o2',
      confidence: 1,
      probabilities: { o1: 0, o2: 1, o3: 0 },
    },
  },
};

test('Jev Agent router uses only its authorized host, Jev shape and separate key; quota is displayed', async () => {
  let calls = 0;
  const provider = createProviderRouter(
    async (origin) => {
      assert.equal(origin, 'https://jev-agent.com/*');
      return true;
    },
    async (url, init) => {
      calls++;
      assert.equal(url, 'https://jev-agent.com/api/v1/systemone');
      assert.equal(
        new Headers(init?.headers).get('Authorization'),
        'Bearer fake-jev-agent-key',
      );
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.credentials, 'omit');
      const body = JSON.parse(init?.body as string);
      assert.equal(body.model, 'jev-latest');
      assert.equal(body.messages, undefined);
      assert.equal(body.questions.answer.type, 'choice');
      const state = JSON.parse(body.state);
      assert.deepEqual(Object.keys(state).sort(), [
        'classification',
        'material',
        'options',
        'stem',
      ]);
      assert.ok(!body.state.includes('fake-jev-agent-key'));
      return Response.json({
        ...singleResponse,
        quota: { charged: 1, remaining: 4 },
      });
    },
  );
  const result = await provider.suggest(demoScan().questions[0]!, context());
  assert.equal(calls, 1);
  assert.equal(result.provider, 'jev-agent/jev');
  assert.deepEqual(result.selectedIds, ['o2']);
  assert.match(result.notices.join(), /本次扣除 1，剩余 4/);
});

test('Jev Agent multiple choices share one request; missing quota does not discard the answer', async () => {
  let calls = 0;
  const provider = createJevProvider(async (_url, init) => {
    calls++;
    const body = JSON.parse(init?.body as string);
    assert.equal(body.questions.o1.type, 'noul');
    return Response.json({
      model: 'jev-1.13.0',
      answers: {
        o1: { type: 'noul', noul: 0.9 },
        o2: { type: 'noul', noul: 0.8 },
        o3: { type: 'noul', noul: 0.1 },
      },
    });
  });
  const result = await provider.suggest(
    demoScan().questions.find((q) => q.kind === 'multiple')!,
    context(),
  );
  assert.equal(calls, 1);
  assert.deepEqual(result.selectedIds, ['o1', 'o2']);
  assert.equal(result.needsReview, false);
  assert.ok(!result.notices.join().includes('剩余'));
});

test('Jev Agent missing permission and free-tier size limits prevent network calls', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json(singleResponse);
  };
  const question = demoScan().questions[0]!;
  await assert.rejects(
    createProviderRouter(async () => false, fetcher).suggest(
      question,
      context(),
    ),
    /尚未授权/,
  );
  const provider = createJevProvider(fetcher);
  await assert.rejects(
    provider.suggest({ ...question, stem: 'x'.repeat(8001) }, context()),
    /超出限制/,
  );
  await assert.rejects(
    provider.suggest(
      {
        ...question,
        kind: 'multiple',
        classification: {
          domain: 'aptitude',
          format: 'multiple-choice',
          intent: 'knowledge',
        },
        options: Array.from({ length: 11 }, (_, i) => ({
          id: `o${i}`,
          label: String(i),
          text: 'test',
        })),
      },
      context(),
    ),
    /超出限制/,
  );
  assert.equal(calls, 0);
});

test('Jev Agent exhausted credit is not called rate limiting; no error triggers fallback or secret reflection', async () => {
  for (const [status, code] of [
    [429, 'CREDIT'],
    [401, 'AUTH'],
  ] as const) {
    let calls = 0;
    const provider = createJevProvider(async () => {
      calls++;
      return new Response('fake-jev-agent-key', { status });
    });
    await assert.rejects(
      provider.suggest(demoScan().questions[0]!, context()),
      (error: unknown) => {
        const safe = publicError(error);
        assert.equal(safe.code, code);
        assert.match(safe.message, /Jev Agent/);
        assert.ok(!safe.message.includes('fake-jev-agent-key'));
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});
