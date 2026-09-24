import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJevRequest,
  createJevProvider,
  JEV_ENDPOINT,
  parseJevResponse,
} from '../src/providers/jev';
import { SettingsSchema } from '../src/core/schema';
import { publicError } from '../src/core/errors';
import { demoScan } from './helpers';

const single = demoScan().questions[0]!;
const multiple = demoScan().questions.find(
  (question) => question.kind === 'multiple',
)!;
const valid = {
  model: 'jev-test',
  answers: {
    answer: {
      type: 'choice',
      choice: 'o2',
      probabilities: { o1: 0.1, o2: 0.8, o3: 0.1 },
      confidence: 0.7,
    },
  },
};
const context = () => ({
  apiKey: 'test-only-fake-key',
  settings: SettingsSchema.parse({}),
  signal: new AbortController().signal,
});

test('Jev receives only question content, not URLs, credentials, or page HTML', async () => {
  const provider = createJevProvider(async (url, init) => {
    assert.equal(url, JEV_ENDPOINT);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    const body = JSON.parse(init?.body as string);
    assert.deepEqual(Object.keys(body.state).sort(), [
      'classification',
      'material',
      'options',
      'stem',
    ]);
    assert.equal(body.questions.answer.type, 'choice');
    assert.ok(!(init?.body as string).includes('test-only-fake-key'));
    return Response.json(valid);
  });
  const result = await provider.suggest(single, context());
  assert.deepEqual(result.selectedIds, ['o2']);
  assert.equal(result.needsReview, true);
});

test('invalid IDs, missing probabilities, inconsistent distributions and NaN are rejected', () => {
  for (const answer of [
    { ...valid.answers.answer, choice: 'made-up' },
    { ...valid.answers.answer, probabilities: { o1: 0.1, o2: 0.8 } },
    { ...valid.answers.answer, probabilities: { o1: 0.8, o2: 0.8, o3: 0.8 } },
    { ...valid.answers.answer, confidence: NaN },
    { ...valid.answers.answer, choice: 'o1' },
  ])
    assert.throws(() =>
      parseJevResponse({ model: 'jev-test', answers: { answer } }, single, 0.8),
    );
});

test('multiple choice uses independent noul results, never a fabricated confidence', () => {
  const request = buildJevRequest(multiple, 'jev-latest');
  assert.ok('o1' in request.questions);
  assert.equal(request.questions.o1?.type, 'noul');
  const result = parseJevResponse(
    {
      model: 'jev-test',
      answers: {
        o1: { type: 'noul', noul: 0.9 },
        o2: { type: 'noul', noul: 0.8 },
        o3: { type: 'noul', noul: 0.1 },
      },
    },
    multiple,
    0.8,
  );
  assert.deepEqual(result.selectedIds, ['o1', 'o2']);
  assert.equal(result.confidence, null);
  assert.equal(result.needsReview, false);
  assert.equal(result.lowConfidence, false);
  assert.equal(result.probabilityKind, 'independent');
  assert.throws(() =>
    parseJevResponse({ model: 'jev-test', answers: {} }, multiple, 0.8),
  );
});

test('multiple-choice gate checks excluded options too and skips the entire uncertain answer set', () => {
  const parse = (values: number[]) =>
    parseJevResponse(
      {
        model: 'test',
        answers: Object.fromEntries(
          values.map((noul, i) => [`o${i + 1}`, { type: 'noul', noul }]),
        ),
      },
      multiple,
      0.8,
    );
  assert.equal(parse([0.96, 0.92, 0.03]).lowConfidence, false);
  assert.equal(
    parse([0.96, 0.92, 0.4]).lowConfidence,
    true,
    'uncertain exclusion must not silently pass',
  );
  assert.equal(
    parse([0.6, 0.92, 0.03]).lowConfidence,
    true,
    'uncertain inclusion skips the whole question',
  );
  assert.equal(
    parse([0.1, 0.1, 0.1]).lowConfidence,
    true,
    'empty answer set is not applied',
  );
  assert.throws(() => parse([0.9, 0.9, 0.1, 0.9]), /数量/);
  const stricter = parseJevResponse(
    {
      model: 'test',
      answers: {
        o1: { type: 'noul', noul: 0.9 },
        o2: { type: 'noul', noul: 0.85 },
        o3: { type: 'noul', noul: 0.1 },
      },
    },
    multiple,
    0.95,
  );
  assert.equal(stricter.lowConfidence, true);
});

test('unsupported visual and personal questions are blocked before network access', async () => {
  let calls = 0;
  const provider = createJevProvider(async () => {
    calls++;
    return Response.json(valid);
  });
  for (const question of demoScan().questions.filter(
    (item) =>
      item.hasVisual || item.kind === 'personal' || item.kind === 'text',
  )) {
    await assert.rejects(provider.suggest(question, context()));
  }
  assert.equal(calls, 0);
});

test('auth/rate-limit failures are actionable and never expose response body secrets', async () => {
  for (const [status, code] of [
    [401, 'AUTH'],
    [429, 'RATE_LIMIT'],
    [529, 'RATE_LIMIT'],
    [500, 'PROVIDER'],
  ] as const) {
    const provider = createJevProvider(
      async () => new Response('secret-key-from-server', { status }),
    );
    await assert.rejects(
      provider.suggest(single, context()),
      (error: unknown) => {
        const safe = publicError(error);
        assert.equal(safe.code, code);
        assert.ok(!safe.message.includes('secret-key'));
        return true;
      },
    );
  }
});

test('cancelled requests and malformed JSON are handled without raw error reflection', async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = createJevProvider(async () => {
    throw new Error('secret');
  });
  await assert.rejects(
    provider.suggest(single, { ...context(), signal: controller.signal }),
    (error: unknown) => publicError(error).code === 'CANCELLED',
  );
  await assert.rejects(
    createJevProvider(async () => new Response('{bad')).suggest(
      single,
      context(),
    ),
    (error: unknown) => publicError(error).code === 'BAD_RESPONSE',
  );
});
