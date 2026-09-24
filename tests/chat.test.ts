import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatProvider, parseChatAnswer } from '../src/providers/chat';
import { createProviderRouter } from '../src/providers';
import { SettingsSchema } from '../src/core/schema';
import {
  astraFlow,
  connectionFor,
  normalizeBaseUrl,
} from '../src/core/connections';
import { publicError } from '../src/core/errors';
import { demoScan } from './helpers';

const question = demoScan().questions[0]!;
const answer = {
  selectedIds: ['o2'],
  confidence: 0.92,
  explanation: '合成测试解释',
};
const envelope = (
  content = JSON.stringify(answer),
  finish_reason = 'stop',
) => ({ choices: [{ message: { content }, finish_reason }] });
const context = (custom = false) => ({
  apiKey: 'fake-private-key',
  settings: SettingsSchema.parse(
    custom
      ? {
          provider: 'custom',
          baseUrl: 'https://api.example.test/v1/',
          model: 'custom-model',
        }
      : { provider: 'openrouter', model: 'example/model' },
  ),
  signal: new AbortController().signal,
});

test('OpenRouter and custom use Chat Completions with only question data and their own endpoint', async () => {
  for (const custom of [false, true]) {
    const ctx = context(custom);
    let calls = 0;
    const provider = createChatProvider(async (url, init) => {
      calls++;
      assert.equal(
        url,
        custom
          ? 'https://api.example.test/v1/chat/completions'
          : 'https://openrouter.ai/api/v1/chat/completions',
      );
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.credentials, 'omit');
      assert.equal(
        new Headers(init?.headers).get('Authorization'),
        'Bearer fake-private-key',
      );
      const body = JSON.parse(init?.body as string);
      assert.equal(body.model, ctx.settings.model);
      assert.equal(body.stream, false);
      assert.equal(body.messages.length, 2);
      const state = JSON.parse(body.messages[1].content);
      assert.deepEqual(Object.keys(state).sort(), [
        'classification',
        'kind',
        'material',
        'options',
        'stem',
      ]);
      assert.ok(!(init?.body as string).includes('fake-private-key'));
      return Response.json(envelope());
    });
    const result = await provider.suggest(question, ctx);
    assert.equal(calls, 1);
    assert.deepEqual(result.selectedIds, ['o2']);
    assert.equal(result.probabilityKind, 'unavailable');
    assert.deepEqual(result.probabilities, {});
    assert.equal(result.needsReview, false);
  }
});

test('chat parser rejects truncated, refused, unknown and duplicate choices without exposing raw content', () => {
  for (const value of [
    envelope(JSON.stringify(answer), 'length'),
    envelope('fake-private-key'),
    envelope(JSON.stringify({ ...answer, selectedIds: ['unknown'] })),
    envelope(JSON.stringify({ ...answer, selectedIds: ['o2', 'o2'] })),
    envelope(JSON.stringify({ ...answer, selectedIds: ['o1', 'o2'] })),
    envelope(JSON.stringify({ ...answer, confidence: 2 })),
    {
      choices: [
        {
          message: { content: JSON.stringify(answer), refusal: 'no' },
          finish_reason: 'stop',
        },
      ],
    },
  ])
    assert.throws(
      () => parseChatAnswer(value, question, 'test', 'custom', 0.8),
      (error: unknown) => {
        assert.equal(publicError(error).code, 'BAD_RESPONSE');
        assert.ok(!publicError(error).message.includes('fake-private-key'));
        return true;
      },
    );
  const missing = parseChatAnswer(
    envelope(JSON.stringify({ selectedIds: ['o2'] })),
    question,
    'test',
    'custom',
    0.8,
  );
  assert.equal(missing.confidence, null);
  assert.equal(missing.needsReview, true);
  assert.deepEqual(
    parseChatAnswer(
      envelope('```json\n' + JSON.stringify(answer) + '\n```'),
      question,
      'test',
      'custom',
      0.8,
    ).selectedIds,
    ['o2'],
  );
  const multiple = { ...question, kind: 'multiple' as const };
  assert.equal(
    parseChatAnswer(envelope(), multiple, 'test', 'custom', 0.8).needsReview,
    false,
  );
});

test('missing permissions, keys and unsupported questions fail before any request', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json(envelope());
  };
  const router = createProviderRouter(async (origin) => {
    assert.equal(origin, 'https://api.example.test/*');
    return false;
  }, fetcher);
  await assert.rejects(router.suggest(question, context(true)), /尚未授权/);
  const provider = createChatProvider(fetcher);
  await assert.rejects(
    provider.suggest(question, { ...context(), apiKey: '' }),
    /保存/,
  );
  await assert.rejects(
    provider.suggest({ ...question, hasVisual: true }, context()),
    /图片/,
  );
  assert.equal(calls, 0);
});

test('custom URLs reject credentials and ambiguous endpoint shapes; keep configured base paths', () => {
  for (const baseUrl of [
    'http://api.test/v1',
    'https://user:secret@api.test/v1',
    'https://api.test/v1?key=private',
    'https://api.test/v1#secret',
    'https://api.test/v1/chat/completions',
  ]) {
    assert.throws(() => normalizeBaseUrl(baseUrl));
    assert.equal(
      SettingsSchema.safeParse({ provider: 'custom', model: 'model', baseUrl })
        .success,
      false,
    );
  }
  assert.equal(
    connectionFor(context(true).settings).endpoint,
    'https://api.example.test/v1/chat/completions',
  );
});

test('chat HTTP errors do not echo secrets or retry another service', async () => {
  let calls = 0;
  const provider = createChatProvider(async () => {
    calls++;
    return new Response('fake-private-key', { status: 401 });
  });
  await assert.rejects(
    provider.suggest(question, context()),
    (error: unknown) => {
      assert.equal(publicError(error).code, 'AUTH');
      assert.ok(!publicError(error).message.includes('fake-private-key'));
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('fixed AstraFlow Flash reserves its token budget for final JSON without changing other models', async () => {
  for (const variant of ['fixed', 'other-host', 'other-model'] as const) {
    const settings = SettingsSchema.parse({
      provider: 'custom',
      baseUrl:
        variant === 'other-host'
          ? 'https://other.example/v1'
          : astraFlow.baseUrl + '/',
      model: variant === 'other-model' ? 'other-model' : astraFlow.model,
    });
    for (const input of [
      question,
      demoScan().questions.find((q) => q.kind === 'text')!,
    ]) {
      const provider = createChatProvider(async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        assert.deepEqual(
          body.thinking,
          variant === 'fixed' ? { type: 'disabled' } : undefined,
        );
        assert.equal(body.max_tokens, input.kind === 'text' ? 4096 : 2048);
        assert.match(
          body.messages[0].content,
          /Do not silently repair contradictory labels/,
        );
        return Response.json(
          envelope(
            JSON.stringify(
              input.kind === 'text'
                ? { answerText: '题目信息不足。', confidence: null }
                : answer,
            ),
          ),
        );
      });
      const result = await provider.suggest(input, {
        ...context(true),
        settings,
      });
      if (input.kind === 'text') {
        assert.equal(result.needsReview, true);
        assert.equal(result.manualOnly, true);
      }
    }
  }
});
