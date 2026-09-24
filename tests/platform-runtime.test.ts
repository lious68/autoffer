import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPlatformRuntime } from '../src/platforms/runtime';
import { scanPage } from '../src/platforms/registry';
import type { PlatformAdapter } from '../src/platforms/types';
import { AutomaticSession, type SessionState } from '../src/content/session';
import type { Suggestion } from '../src/core/schema';
import { demoScan } from './helpers';

function fixture() {
  let question = { ...demoScan().questions[0]!, id: 'other:1' };
  const calls: string[] = [];
  const adapter: PlatformAdapter = {
    meta: {
      id: 'other',
      name: 'Synthetic second platform',
      version: '1',
      status: 'experimental',
    },
    matches: ({ url }) => url.hostname === 'other.invalid',
    extract: () => ({
      platform: adapter.meta,
      questions: [question],
      warnings: [],
    }),
  };
  const context = {
    document: new JSDOM('<body>').window.document,
    url: new URL('https://other.invalid/'),
  };
  const suggestion: Suggestion = {
    questionId: question.id,
    provider: 'test',
    model: 'fake',
    selectedIds: [question.options[0]!.id],
    probabilities: {},
    confidence: 0.95,
    needsReview: false,
    probabilityKind: 'unavailable',
    notices: [],
  };
  const runtime = createPlatformRuntime(context, [adapter]);
  return {
    question,
    change: () => {
      question = { ...question, stem: 'Changed' };
    },
    adapter,
    context,
    runtime,
    suggestion,
    calls,
  };
}

test('a second platform routes its registered actions without a Nowcoder dependency', async () => {
  const f = fixture();
  f.adapter.actions = {
    answerKinds: ['single'],
    assertReady: () => {
      f.calls.push('assert');
    },
    apply: async () => {
      f.calls.push('apply');
      return 'section-end';
    },
    skip: async () => {
      f.calls.push('skip');
      return 'advanced';
    },
  };
  assert.deepEqual(f.runtime.capabilities(f.question), {
    answer: true,
    advance: true,
  });
  assert.equal(
    await f.runtime.apply(
      f.question,
      f.suggestion,
      new AbortController().signal,
    ),
    'section-end',
  );
  assert.equal(
    await f.runtime.skip(f.question, new AbortController().signal),
    'advanced',
  );
  assert.deepEqual(f.calls, ['assert', 'apply', 'assert', 'skip']);
  f.change();
  await assert.rejects(
    f.runtime.apply(f.question, f.suggestion, new AbortController().signal),
    /已经变化/,
  );
  assert.equal(f.calls.length, 4);
});

test('capability, cancellation, invalid answers and review gates stop before platform writes', async () => {
  const f = fixture();
  assert.deepEqual(f.runtime.capabilities(f.question), {
    answer: false,
    advance: false,
  });
  await assert.rejects(
    f.runtime.apply(f.question, f.suggestion, new AbortController().signal),
    /尚未适配/,
  );
  f.adapter.actions = {
    answerKinds: ['single'],
    assertReady() {},
    apply: async () => {
      f.calls.push('write');
      return 'advanced';
    },
  };
  for (const suggestion of [
    { ...f.suggestion, questionId: 'stale' },
    { ...f.suggestion, selectedIds: ['invalid'] },
    {
      ...f.suggestion,
      selectedIds: [f.question.options[0]!.id, f.question.options[1]!.id],
    },
    { ...f.suggestion, needsReview: true },
    { ...f.suggestion, manualOnly: true },
  ])
    await assert.rejects(
      f.runtime.apply(f.question, suggestion, new AbortController().signal),
    );
  await assert.rejects(
    f.runtime.apply(f.question, f.suggestion, AbortSignal.abort()),
    /已停止/,
  );
  await assert.rejects(
    f.runtime.skip(f.question, new AbortController().signal),
    /尚未适配翻页/,
  );
  assert.deepEqual(f.calls, []);
});

test('registry rejects ambiguous platforms and invalid custom extraction before use', () => {
  const f = fixture();
  assert.match(
    scanPage(f.context, [
      f.adapter,
      { ...f.adapter, meta: { ...f.adapter.meta, id: 'conflict' } },
    ]).warnings[0]!,
    /多个平台/,
  );
  assert.equal(
    scanPage(f.context, [
      {
        ...f.adapter,
        extract: () => ({
          platform: f.adapter.meta,
          questions: [{ ...f.question, stem: '' }],
          warnings: [],
        }),
      },
    ]).questions.length,
    0,
  );
  assert.equal(
    scanPage(f.context, [
      {
        ...f.adapter,
        extract: () => ({
          platform: { ...f.adapter.meta, id: 'wrong' },
          questions: [f.question],
          warnings: [],
        }),
      },
    ]).platform,
    null,
  );
});

test('read-only adapters still solve in automatic mode and preserve reference reports without page actions', async () => {
  const f = fixture();
  const states: SessionState[] = [];
  let requests = 0;
  const session = new AutomaticSession({
    settleMs: 0,
    capabilities: f.runtime.capabilities,
    suggest: async () => {
      requests++;
      return f.suggestion;
    },
    apply: f.runtime.apply,
    skip: f.runtime.skip,
    cancel: async () => {},
    emit: (s) => states.push(s),
  });
  session.start(true);
  session.observe(f.question);
  await session.settled();
  session.observe(f.question);
  await session.settled();
  assert.equal(requests, 1);
  assert.equal(states.at(-1)?.phase, 'ready');
  assert.equal(states.at(-1)?.completed, 0);
  const report = session.end();
  assert.equal(report.records[0]?.status, 'reference');
  assert.deepEqual(
    report.records[0]?.classification,
    f.question.classification,
  );
});

test('read-only self-report questions do not request a model or attempt navigation', async () => {
  const f = fixture();
  const states: SessionState[] = [];
  const session = new AutomaticSession({
    settleMs: 0,
    capabilities: () => ({ answer: false, advance: false }),
    suggest: async () => {
      assert.fail('must not call a provider');
    },
    apply: f.runtime.apply,
    skip: f.runtime.skip,
    cancel: async () => {},
    emit: (s) => states.push(s),
  });
  session.start(true);
  session.observe({
    ...f.question,
    kind: 'personal',
    classification: {
      domain: 'psychological',
      format: 'scale',
      intent: 'self-report',
    },
  });
  await session.settled();
  assert.equal(states.at(-1)?.phase, 'ready');
  assert.match(states.at(-1)?.message ?? '', /真实情况/);
  assert.equal(session.end().reachedEnd, false);
});

test('low confidence uses navigation independently of answer capabilities and never invents a section end', async () => {
  for (const capability of [
    { answer: false, advance: true },
    { answer: true, advance: false },
    { answer: false, advance: false },
  ]) {
    const f = fixture();
    let skips = 0;
    const states: SessionState[] = [];
    const session = new AutomaticSession({
      settleMs: 0,
      capabilities: () => capability,
      suggest: async () => ({
        ...f.suggestion,
        lowConfidence: true,
        needsReview: true,
        confidence: 0.5,
      }),
      apply: async () => {
        assert.fail('must not write a low-confidence answer');
      },
      skip: async () => {
        skips++;
        return 'advanced';
      },
      cancel: async () => {},
      emit: (state) => states.push(state),
    });
    session.start(true);
    session.observe(f.question);
    await session.settled();
    assert.equal(skips, capability.advance ? 1 : 0);
    assert.equal(
      states.at(-1)?.phase,
      capability.advance ? 'watching' : 'ready',
    );
    const report = session.end();
    assert.equal(report.reachedEnd, false);
    assert.equal(report.records[0]?.status, 'skipped');
  }
});
