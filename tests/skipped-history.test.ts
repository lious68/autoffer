import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSkippedHistory } from '../src/content/skipped-history';
import type { SessionState } from '../src/content/session';

test('skip list shows all records safely, preserves expansion, and clears only for a new run', () => {
  const dom = new JSDOM('<body>');
  const history = createSkippedHistory(dom.window.document);
  dom.window.document.body.append(history.root);
  const state: SessionState = {
    phase: 'watching',
    message: 'next',
    running: true,
    autoAnswer: true,
    completed: 0,
    skipped: 2,
    historyDropped: 0,
    skippedHistory: [1, 4].map((n) => ({
      questionId: `q${n}`,
      sequence: n,
      type: '多选',
      stem: `题目 ${n} <script>unsafe</script>`,
      status: 'skipped',
      selectedLabels: ['A', 'C'],
      confidence: null,
      durationMs: 10,
      reason: '置信度不足',
      notices: ['最低确定度 61%，要求 80%。'],
    })),
  };
  history.update(state);
  assert.equal(history.root.querySelectorAll('.skip-item').length, 2);
  assert.match(history.root.textContent!, /本轮第 1 题/);
  assert.match(history.root.textContent!, /本轮第 4 题/);
  assert.match(history.root.textContent!, /A、C（未自动选答）/);
  assert.match(history.root.textContent!, /61%/);
  assert.equal(history.root.querySelector('script'), null);
  const first = history.root.querySelector<HTMLDetailsElement>('.skip-item')!;
  first.open = true;
  history.update({ ...state, phase: 'done', running: false });
  assert.equal(history.root.open, true);
  assert.equal(
    history.root.querySelector<HTMLDetailsElement>('.skip-item')?.open,
    true,
  );
  history.update({ ...state, phase: 'paused', historyDropped: 2 });
  assert.equal(history.root.querySelectorAll('.skip-item').length, 2);
  assert.match(history.root.textContent!, /较早 2 条/);
  history.update({ ...state, skipped: 0, skippedHistory: [] });
  assert.equal(history.root.hidden, true);
  assert.equal(history.root.querySelectorAll('.skip-item').length, 0);
  dom.window.close();
});
