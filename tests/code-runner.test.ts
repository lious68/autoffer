import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodeRunner } from '../src/content/code-runner';
import { parseChatAnswer } from '../src/providers/chat';
import type { Question, Suggestion } from '../src/core/schema';
import { AutomaticSession, type SessionState } from '../src/content/session';

const question: Question = {
  id: 'nowcoder:acm:sample',
  kind: 'text',
  classification: {
    format: 'programming',
    domain: 'professional',
    intent: 'knowledge',
  },
  stem: 'Self-authored sum task',
  material: '',
  options: [],
  warnings: [],
  hasVisual: false,
};
const suggestion: Suggestion = {
  questionId: question.id,
  provider: 'custom',
  model: 'test',
  selectedIds: [],
  confidence: 0.95,
  probabilities: {},
  probabilityKind: 'unavailable',
  needsReview: false,
  manualOnly: false,
  notices: [],
  answerText: 'print(1)',
  editor: { token: 'ticket', language: 'Python3' },
};

test('provider enables code only when the actual editor language is supplied', () => {
  const envelope = {
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({ answerText: 'print(1)', confidence: 0.95 }),
        },
      },
    ],
  };
  assert.equal(
    parseChatAnswer(envelope, question, 'test', 'custom', 0.8).manualOnly,
    true,
  );
  const code = parseChatAnswer(
    envelope,
    { ...question, programmingLanguage: 'Python3' },
    'test',
    'custom',
    0.8,
  );
  assert.equal(code.manualOnly, false);
  assert.equal(code.needsReview, false);
  assert.equal(
    parseChatAnswer(
      envelope,
      { ...question, programmingLanguage: 'Python3' },
      'test',
      'custom',
      0.99,
    ).lowConfidence,
    true,
  );
});

test('code runner performs fill, self-test, submit, fresh judge, then advance', async () => {
  const calls: string[] = [];
  let submitted = false;
  const runner = createCodeRunner(
    async (c) => {
      calls.push(c.action);
      if (c.action === 'submit') submitted = true;
      return {
        state:
          c.action === 'fill'
            ? 'filled'
            : c.action === 'poll'
              ? submitted
                ? 'accepted'
                : 'passed'
              : 'running',
        message: 'ok',
      };
    },
    () => {},
    async () => {
      calls.push('next');
      return 'section-end';
    },
    0,
  );
  assert.equal(
    await runner(question, suggestion, new AbortController().signal, () => {}),
    'section-end',
  );
  assert.deepEqual(calls, [
    'fill',
    'run',
    'poll',
    'submit',
    'poll',
    'next',
    'cancel',
  ]);
});

test('self-test failures and cancellation prevent submission and advancement', async () => {
  for (const cancel of [false, true]) {
    const abort = new AbortController(),
      calls: string[] = [];
    const runner = createCodeRunner(
      async (c) => {
        calls.push(c.action);
        if (cancel && c.action === 'run') abort.abort();
        return {
          state:
            c.action === 'fill'
              ? 'filled'
              : c.action === 'poll'
                ? 'failed'
                : 'running',
          message: 'compile error',
        };
      },
      () => {},
      async () => {
        calls.push('next');
        return 'advanced';
      },
      0,
    );
    await assert.rejects(runner(question, suggestion, abort.signal, () => {}));
    assert.ok(!calls.includes('submit'));
    assert.ok(!calls.includes('next'));
  }
});

test('automatic session counts ACM only after the code runner succeeds and records failed runs', async () => {
  for (const fail of [false, true]) {
    const states: SessionState[] = [];
    const session = new AutomaticSession({
      settleMs: 0,
      emit: (s) => states.push(s),
      capabilities: () => ({ answer: true, advance: true }),
      suggest: async () => suggestion,
      cancel: async () => {},
      skip: async () => 'advanced',
      apply: async () => {
        throw new Error('must not click choices');
      },
      applyProgramming: async (_q, _s, _signal, progress) => {
        progress('代码已回填，正在自测…');
        if (fail) throw new Error('编译错误');
        return 'section-end';
      },
    });
    session.start();
    session.observe(question);
    await session.settled();
    assert.equal(states.at(-1)!.completed, fail ? 0 : 1);
    const report = session.end();
    assert.equal(report.records[0]!.status, fail ? 'failed' : 'answered');
    assert.equal(report.records[0]!.answerText, 'print(1)');
    assert.ok(states.some((s) => s.message === '代码已回填，正在自测…'));
  }
});

test('controller prepares editor before inference, sends only language, and returns editor ticket separately', async () => {
  const { Controller } = await import('../src/background/controller');
  const { modelPresets } = await import('../src/core/connections');
  let prepared = 0,
    called = 0;
  const controller = new Controller({
    scan: async () => ({
      documentId: 'doc',
      page: 'https://exam.nowcoder.com/cts/123/summary',
      scan: { platform: null, questions: [question], warnings: [] },
    }),
    vault: {
      read: async () => ({ apiKey: 'fake', settings: modelPresets.chat }),
      save: async () => {},
    },
    prepareProgramming: async () => {
      prepared++;
      return { token: 'local-ticket', language: 'Python3' };
    },
    provider: {
      id: 'fake',
      suggest: async (q) => {
        called++;
        assert.equal(prepared, 1);
        assert.equal(q.programmingLanguage, 'Python3');
        assert.ok(!JSON.stringify(q).includes('local-ticket'));
        return { ...suggestion, editor: undefined };
      },
    },
  });
  const scan = (await controller.handle({ type: 'scan', tabId: 42 })) as {
    scanId: string;
  };
  const result = (await controller.handle({
    type: 'suggest',
    tabId: 42,
    scanId: scan.scanId,
    questionId: question.id,
  })) as Suggestion;
  assert.equal(called, 1);
  assert.equal(result.editor?.token, 'local-ticket');
});
