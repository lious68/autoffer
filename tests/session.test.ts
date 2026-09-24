import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/core/errors';
import { AutomaticSession, type SessionState } from '../src/content/session';
import type { Question, Suggestion } from '../src/core/schema';

const question = (n: number): Question => ({
  id: `q${n}`,
  kind: 'single',
  stem: `Sample ${n}`,
  material: '',
  options: [
    { id: 'a', label: 'A', text: 'a' },
    { id: 'b', label: 'B', text: 'b' },
  ],
  warnings: [],
  hasVisual: false,
});
const answer = (q: Question, confidence = 0.95): Suggestion => ({
  questionId: q.id,
  selectedIds: ['a'],
  provider: 'test',
  model: 'fake',
  confidence,
  needsReview: confidence < 0.8,
  probabilities: { a: confidence, b: 1 - confidence },
  probabilityKind: 'distribution',
  notices: [],
});

test('automatic mode continues beyond five questions, skips low confidence, waits at skipped section boundaries without stopping recognition', async () => {
  let now = 0;
  const states: SessionState[] = [],
    calls: string[] = [],
    selected: string[] = [],
    skipped: string[] = [];
  const session = new AutomaticSession({
    now: () => now,
    emit: (s) => states.push(s),
    cancel: async () => {},
    suggest: async (q) => {
      calls.push(q.id);
      return answer(q, q.id === 'q2' || q.id === 'q15' ? 0.5 : 0.95);
    },
    apply: async (q) => {
      selected.push(q.id);
      return q.id === 'q15' ? 'section-end' : 'advanced';
    },
    skip: async (q) => {
      skipped.push(q.id);
      return q.id === 'q15' ? 'section-end' : 'advanced';
    },
  });
  session.start();
  for (let i = 1; i <= 15; i++) {
    const q = question(i);
    session.observe(q);
    now += 700;
    session.observe(q);
    await session.settled();
    session.observe(q);
    await session.settled(); // DOM noise must not recharge the same question.
  }
  assert.equal(calls.length, 15);
  assert.equal(selected.length, 13);
  assert.deepEqual(skipped, ['q2', 'q15']);
  assert.equal(states.at(-1)?.phase, 'done');
  assert.equal(states.at(-1)?.running, true);
  assert.equal(states.at(-1)?.skipped, 2);
  assert.equal(session.controlState().atEnd, true);
  session.observe(question(16));
  assert.equal(
    session.controlState().atEnd,
    false,
    'a manually opened next section allows continuing the existing run',
  );
  now += 700;
  session.observe(question(16));
  await session.settled();
  assert.equal(calls.length, 16);
});

test('manual next while a model is pending cancels it and discards its late answer', async () => {
  let now = 0,
    resolve: (s: Suggestion) => void = () => {};
  const applied: string[] = [],
    calls: string[] = [];
  const session = new AutomaticSession({
    now: () => now,
    emit: () => {},
    cancel: async () => {},
    suggest: async (q) => {
      calls.push(q.id);
      return q.id === 'q1'
        ? new Promise<Suggestion>((r) => {
            resolve = r;
          })
        : answer(q);
    },
    apply: async (q) => {
      applied.push(q.id);
      return 'advanced';
    },
    skip: async () => 'advanced',
  });
  session.start();
  session.observe(question(1));
  now = 700;
  session.observe(question(1));
  await new Promise((r) => setImmediate(r));
  session.observe(question(2));
  now = 1400;
  session.observe(question(2));
  resolve(answer(question(1)));
  await session.settled();
  session.observe(question(2));
  await session.settled();
  assert.deepEqual(calls, ['q1', 'q2']);
  assert.deepEqual(applied, ['q2']);
});

test('analysis-only mode automatically parses each new question and reuses cached answers on return', async () => {
  let now = 0,
    calls = 0,
    actions = 0;
  const session = new AutomaticSession({
    now: () => now,
    emit: () => {},
    cancel: async () => {},
    suggest: async (q) => {
      calls++;
      return answer(q);
    },
    apply: async () => {
      actions++;
      return 'advanced';
    },
    skip: async () => {
      actions++;
      return 'advanced';
    },
  });
  session.start(false);
  for (const n of [1, 2, 1]) {
    session.observe(question(n));
    now += 700;
    session.observe(question(n));
    await session.settled();
  }
  assert.equal(calls, 2);
  assert.equal(actions, 0);
});

test('unknown confidence waits for confirmation without another model charge; stop prevents future work', async () => {
  let now = 0,
    calls = 0,
    applied = 0;
  let state: SessionState | undefined;
  const session = new AutomaticSession({
    now: () => now,
    emit: (s) => {
      state = s;
    },
    cancel: async () => {},
    suggest: async (q) => {
      calls++;
      return { ...answer(q), confidence: null, needsReview: true };
    },
    apply: async (_q, _a, _s, reviewed) => {
      assert.equal(reviewed, true);
      applied++;
      return 'advanced';
    },
    skip: async () => {
      throw new Error('must not skip unknown');
    },
  });
  session.start();
  session.observe(question(1));
  now = 700;
  session.observe(question(1));
  await session.settled();
  assert.equal(state?.phase, 'review');
  session.confirm();
  await session.settled();
  assert.equal(calls, 1);
  assert.equal(applied, 1);
  session.stop();
  session.observe(question(2));
  now = 1400;
  session.observe(question(2));
  await session.settled();
  assert.equal(calls, 1);
});

test('multiple-choice review is not mistaken for low confidence, but an explicit low-confidence result is skipped', async () => {
  const q = { ...question(1), kind: 'multiple' as const };
  let skipped = 0,
    applied = 0;
  const session = new AutomaticSession({
    settleMs: 0,
    emit: () => {},
    cancel: async () => {},
    suggest: async () => ({
      ...answer(q),
      needsReview: true,
      lowConfidence: false,
    }),
    apply: async () => {
      applied++;
      return 'advanced';
    },
    skip: async () => {
      skipped++;
      return 'advanced';
    },
  });
  session.start();
  session.observe(q);
  await session.settled();
  assert.equal(applied, 0);
  assert.equal(skipped, 0);
  session.confirm();
  await session.settled();
  assert.equal(applied, 1);
  const low = new AutomaticSession({
    settleMs: 0,
    emit: () => {},
    cancel: async () => {},
    suggest: async () => ({ ...answer(q, 0.5), lowConfidence: true }),
    apply: async () => {
      throw new Error('must not select');
    },
    skip: async () => {
      skipped++;
      return 'section-end';
    },
  });
  low.start();
  low.observe(q);
  await low.settled();
  assert.equal(skipped, 1);
});

test('failed provider keeps watching without a request storm; stop during request never applies its late answer', async () => {
  let now = 0,
    calls = 0;
  let state: SessionState | undefined;
  const session = new AutomaticSession({
    now: () => now,
    emit: (s) => {
      state = s;
    },
    cancel: async () => {},
    suggest: async () => {
      calls++;
      throw new Error('auth failed');
    },
    apply: async () => {
      throw new Error('must not apply');
    },
    skip: async () => 'advanced',
  });
  session.start();
  session.observe(question(1));
  now = 700;
  session.observe(question(1));
  await session.settled();
  for (let i = 0; i < 10; i++) {
    now += 700;
    session.observe(question(1));
    await session.settled();
  }
  assert.equal(calls, 1);
  assert.equal(state?.phase, 'error');
  assert.equal(state?.running, true);
  let resolve: (s: Suggestion) => void = () => {};
  let actions = 0;
  const late = new AutomaticSession({
    settleMs: 0,
    emit: () => {},
    cancel: async () => {},
    suggest: async () =>
      new Promise((r) => {
        resolve = r;
      }),
    apply: async () => {
      actions++;
      return 'advanced';
    },
    skip: async () => 'advanced',
  });
  late.start();
  late.observe(question(1));
  await new Promise((r) => setImmediate(r));
  late.stop();
  resolve(answer(question(1)));
  await late.settled();
  assert.equal(actions, 0);
});

test('personal and unmapped visual questions skip without model calls and continue until the section boundary', async () => {
  let calls = 0,
    skips = 0,
    state: SessionState | undefined;
  const session = new AutomaticSession({
    settleMs: 0,
    emit: (s) => {
      state = s;
    },
    cancel: async () => {},
    suggest: async (q) => {
      calls++;
      return answer(q);
    },
    apply: async () => 'advanced',
    skip: async () => {
      skips++;
      return skips === 2 ? 'section-end' : 'advanced';
    },
  });
  session.start();
  session.observe({
    ...question(1),
    kind: 'personal',
    typeLabel: '问答',
    options: [],
  });
  await session.settled();
  session.observe({ ...question(2), hasVisual: true });
  await session.settled();
  assert.equal(calls, 0);
  assert.equal(skips, 2);
  assert.equal(state?.skipped, 2);
  assert.equal(state?.phase, 'done');
});

test('skipped history retains every question across navigation, pause and end, without duplicating a retried question', async () => {
  const states: SessionState[] = [];
  const session = new AutomaticSession({
    settleMs: 0,
    emit: (state) => states.push(state),
    cancel: async () => {},
    suggest: async (q) => ({
      ...answer(q, q.id === 'q2' ? 0.95 : 0.6),
      notices: ['最低确定度 60%，要求 80%。'],
    }),
    apply: async () => 'advanced',
    skip: async (q) => (q.id === 'q3' ? 'section-end' : 'advanced'),
  });
  session.start();
  for (const n of [1, 2, 3]) {
    session.observe(question(n));
    await session.settled();
  }
  const final = states.at(-1)!;
  assert.deepEqual(
    final.skippedHistory.map((r) => [r.questionId, r.sequence]),
    [
      ['q1', 1],
      ['q3', 3],
    ],
  );
  assert.equal(final.skipped, 2);
  assert.deepEqual(final.skippedHistory[0]?.selectedLabels, ['A']);
  assert.deepEqual(final.skippedHistory[0]?.notices, [
    '最低确定度 60%，要求 80%。',
  ]);
  session.stop();
  assert.equal(states.at(-1)?.skippedHistory.length, 2);
  session.start();
  session.observe(question(3));
  await session.settled();
  assert.equal(states.at(-1)?.skipped, 2);
  assert.equal(states.at(-1)?.skippedHistory.length, 2);
  const report = session.end();
  assert.equal(report.records.filter((r) => r.status === 'skipped').length, 2);
  assert.equal(states.at(-1)?.skippedHistory.length, 2);
  session.start();
  assert.equal(states.at(-1)?.skippedHistory.length, 0);
  assert.equal(
    final.skippedHistory.length,
    2,
    'earlier UI snapshots stay immutable',
  );
});

test('only a completely observed and answered section advances; skipped or missing questions block it', async () => {
  for (const mode of ['complete', 'skipped', 'partial', 'reference'] as const) {
    let crossings = 0;
    let state!: SessionState;
    const session = new AutomaticSession({
      settleMs: 0,
      emit: (value) => {
        state = value;
      },
      cancel: async () => {},
      suggest: async (q) =>
        mode === 'reference' && q.id === 'q1'
          ? { ...answer(q), manualOnly: true }
          : answer(q, mode === 'skipped' && q.id === 'q1' ? 0.5 : 0.95),
      apply: async (q) => (q.id === 'q2' ? 'section-end' : 'advanced'),
      skip: async () => 'advanced',
      nextSection: async () => {
        crossings++;
        return 'advanced';
      },
    });
    session.start();
    for (const n of mode === 'partial' ? [2] : [1, 2]) {
      session.observe({ ...question(n), section: { id: 'single', index: n } });
      await session.settled();
    }
    assert.equal(crossings, mode === 'complete' ? 1 : 0);
    assert.equal(state.running, true);
    // A manual or automatic section change needs no extra start click.
    session.observe({ ...question(3), section: { id: 'multiple', index: 1 } });
    await session.settled();
    assert.equal(state.completed, mode === 'complete' ? 3 : 2);
    session.stop();
    assert.equal(state.running, false);
  }
});

test('skips from a previous section do not block a later completely answered section', async () => {
  let crossings = 0;
  const session = new AutomaticSession({
    settleMs: 0,
    emit: () => {},
    cancel: async () => {},
    suggest: async (q) => answer(q, q.id === 'q1' ? 0.5 : 0.95),
    apply: async () => 'section-end',
    skip: async () => 'section-end',
    nextSection: async () => {
      crossings++;
      return 'advanced';
    },
  });
  session.start();
  session.observe({ ...question(1), section: { id: 'first', index: 1 } });
  await session.settled();
  assert.equal(crossings, 0);
  session.observe({ ...question(2), section: { id: 'second', index: 1 } });
  await session.settled();
  assert.equal(crossings, 1);
});

test('transient model failures retry with backoff, remain cancellable, and eventually wait without a request storm', async () => {
  let now = 0,
    calls = 0;
  const session = new AutomaticSession({
    now: () => now,
    settleMs: 0,
    emit: () => {},
    cancel: async () => {},
    suggest: async () => {
      calls++;
      throw new AppError('NETWORK', '暂时无法连接');
    },
    apply: async () => 'advanced',
    skip: async () => 'advanced',
  });
  session.start();
  for (const time of [0, 1, 4999, 5000, 5001, 20000, 65000, 999999]) {
    now = time;
    session.observe(question(1));
    await session.settled();
  }
  assert.equal(calls, 4);
  assert.equal(session.controlState().running, true);
  session.stop();
  now += 100000;
  session.observe(question(2));
  await session.settled();
  assert.equal(calls, 4);
});

test('two unscored code examples advance without model calls, counters or report records', async () => {
  let calls = 0,
    advances = 0;
  let state!: SessionState;
  const session = new AutomaticSession({
    settleMs: 0,
    emit: (value) => {
      state = value;
    },
    cancel: async () => {},
    capabilities: () => ({ answer: false, advance: true }),
    suggest: async (q) => {
      calls++;
      return { ...answer(q), manualOnly: true, answerText: 'reference' };
    },
    apply: async () => {
      throw new Error('Never write code');
    },
    skip: async () => {
      advances++;
      return 'advanced';
    },
  });
  session.start();
  for (const n of [1, 2]) {
    session.observe({
      ...question(n),
      kind: 'text',
      options: [],
      isExample: true,
    });
    await session.settled();
  }
  assert.equal(calls, 0);
  assert.equal(advances, 2);
  assert.equal(state.completed, 0);
  assert.equal(state.skipped, 0);
  session.observe({
    ...question(3),
    kind: 'text',
    options: [],
    isExample: false,
  });
  await session.settled();
  assert.equal(calls, 1);
  assert.equal(advances, 2);
  assert.equal(session.end().records.length, 1);
});
