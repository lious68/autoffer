import { createPlatformRuntime } from '../src/platforms/runtime';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import {
  assertAnswerPage,
  assertQuestionPage,
  selectAndAdvance,
  advanceWithoutAnswer,
  advanceSection,
} from '../src/platforms/nowcoder/actions';
import { mountTools } from '../src/content/tools';
import type { Suggestion } from '../src/core/schema';
import { parseJevResponse } from '../src/providers/jev';

function fixture() {
  const dom = new JSDOM(
    readFileSync('tests/fixtures/nowcoder-choice.html', 'utf8'),
    { url: 'https://exam.nowcoder.com/cts/123/summary' },
  );
  const document = dom.window.document;
  for (const template of document.querySelectorAll<HTMLTemplateElement>(
    'template[data-shadow-fixture]',
  )) {
    template
      .parentElement!.attachShadow({ mode: 'open' })
      .append(template.content.cloneNode(true));
    template.remove();
  }
  const context = { document, url: new URL(document.URL) };
  const nodes = [...document.querySelectorAll<HTMLElement>('.option-item')];
  const next = document.querySelector('button')!;
  const questionBlock = document.querySelector('.question-preview-container')!;
  [...nodes, next].forEach((node, index) => {
    node.getBoundingClientRect = () =>
      ({ left: 0, top: index * 40, width: 10, height: 10 }) as DOMRect;
  });
  document.elementFromPoint = (_x, y) => [...nodes, next][Math.floor(y / 40)]!;
  nodes.forEach((node) =>
    node.addEventListener('click', () => {
      if (document.querySelector('.type')!.textContent === '单选')
        nodes.forEach((n) => n.classList.remove('selected'));
      node.classList.toggle('selected');
    }),
  );
  let advances = 0;
  next.addEventListener('click', () => {
    advances++;
    questionBlock.querySelector('.tw-text-size-head-pure')!.textContent = '2.';
  });
  const question = assertAnswerPage(context);
  const suggestion: Suggestion = {
    questionId: question.id,
    provider: 'test',
    model: 'test',
    selectedIds: ['o2'],
    probabilities: { o1: 0, o2: 1, o3: 0, o4: 0 },
    confidence: 0.95,
    probabilityKind: 'distribution',
    needsReview: false,
    notices: [],
  };
  return {
    dom,
    document,
    context,
    nodes,
    next,
    question,
    suggestion,
    advances: () => advances,
  };
}

test('registered Nowcoder runtime selects the exact option, verifies state, then advances once', async () => {
  const f = fixture();
  assert.equal(
    await createPlatformRuntime(f.context).apply(
      f.question,
      f.suggestion,
      new AbortController().signal,
    ),
    'advanced',
  );
  assert.deepEqual(
    f.nodes.map((n) => n.classList.contains('selected')),
    [false, true, false, false],
  );
  assert.equal(f.advances(), 1);
  f.dom.window.close();
});

test('low-confidence skip does not select options and never submits the final question', async () => {
  for (const last of [false, true]) {
    const f = fixture();
    if (last) f.next.textContent = '提交本题型';
    assert.equal(
      await advanceWithoutAnswer(
        f.context,
        f.question,
        new AbortController().signal,
      ),
      last ? 'section-end' : 'advanced',
    );
    assert.equal(f.advances(), last ? 0 : 1);
    assert.ok(f.nodes.every((n) => !n.classList.contains('selected')));
    f.dom.window.close();
  }
});

test('hidden previous question and active-only focus do not count as selected answers', async () => {
  const f = fixture();
  const old = f.document
    .querySelector('.question-preview-container')!
    .cloneNode(true) as HTMLElement;
  old.style.display = 'none';
  old.querySelector('.option-item')!.classList.add('selected');
  f.document.body.prepend(old);
  f.nodes[1]!.classList.add('active');
  await selectAndAdvance(
    f.context,
    f.question,
    f.suggestion,
    new AbortController().signal,
  );
  assert.equal(f.nodes[1]!.classList.contains('selected'), true);
  assert.equal(
    old.querySelector('.option-item')!.classList.contains('selected'),
    true,
  );
  assert.equal(f.advances(), 1);
  f.dom.window.close();
});

test('stale questions, unreviewed suggestions, cancellation and blocking dialogs never click', async () => {
  for (const mode of [
    'stale',
    'review',
    'cancel',
    'dialog',
    'covered',
    'invalid',
  ]) {
    const f = fixture();
    const job = new AbortController();
    if (mode === 'stale')
      f.document.querySelector('.tw-text-size-head-pure')!.textContent = '3.';
    if (mode === 'review') f.suggestion.needsReview = true;
    if (mode === 'cancel') job.abort();
    if (mode === 'dialog')
      f.document.querySelector('.dialog')!.setAttribute('role', 'dialog');
    if (mode === 'covered') f.document.elementFromPoint = () => f.document.body;
    if (mode === 'invalid') f.suggestion.selectedIds = ['unknown'];
    await assert.rejects(
      selectAndAdvance(f.context, f.question, f.suggestion, job.signal),
    );
    assert.equal(f.advances(), 0);
    assert.ok(f.nodes.every((n) => !n.classList.contains('selected')));
    f.dom.window.close();
  }
});

test('does not advance when selection fails or question changes while selecting', async () => {
  for (const mode of ['missing-state', 'changed']) {
    const f = fixture();
    f.nodes[1]!.addEventListener('click', () => {
      if (mode === 'missing-state') f.nodes[1]!.classList.remove('selected');
      else
        f.document.querySelector('.tw-text-size-head-pure')!.textContent = '4.';
    });
    await assert.rejects(
      selectAndAdvance(
        f.context,
        f.question,
        f.suggestion,
        new AbortController().signal,
      ),
    );
    assert.equal(f.advances(), 0);
    f.dom.window.close();
  }
});

test('section end never clicks submit, ambiguous next, or disabled next', async () => {
  for (const mode of ['submit', 'ambiguous', 'disabled']) {
    const f = fixture();
    if (mode === 'submit') f.next.textContent = '提交本题型';
    if (mode === 'ambiguous') f.document.body.append(f.next.cloneNode(true));
    if (mode === 'disabled') f.next.disabled = true;
    assert.equal(
      await selectAndAdvance(
        f.context,
        f.question,
        f.suggestion,
        new AbortController().signal,
      ),
      'section-end',
    );
    assert.equal(f.advances(), 0);
    f.dom.window.close();
  }
});

test('reviewed multiple choice toggles the exact set including deselection', async () => {
  const f = fixture();
  f.document.querySelector('.type')!.textContent = '不定项';
  const question = assertAnswerPage(f.context);
  f.nodes[0]!.classList.add('selected');
  const suggestion = {
    ...f.suggestion,
    questionId: question.id,
    selectedIds: ['o2', 'o4'],
    needsReview: true,
  };
  await selectAndAdvance(
    f.context,
    question,
    suggestion,
    new AbortController().signal,
    true,
  );
  assert.deepEqual(
    f.nodes.map((n) => n.classList.contains('selected')),
    [false, true, false, true],
  );
  f.dom.window.close();
});

test('confident Jev multiple-answer set is automatically applied exactly without a manual review step', async () => {
  const f = fixture();
  f.document.querySelector('.type')!.textContent = '不定项';
  const q = assertAnswerPage(f.context);
  f.nodes[1]!.classList.add('selected');
  const result = parseJevResponse(
    {
      model: 'test',
      answers: {
        o1: { type: 'noul', noul: 0.97 },
        o2: { type: 'noul', noul: 0.03 },
        o3: { type: 'noul', noul: 0.96 },
        o4: { type: 'noul', noul: 0.02 },
      },
    },
    q,
    0.8,
  );
  assert.equal(result.needsReview, false);
  assert.equal(
    await selectAndAdvance(f.context, q, result, new AbortController().signal),
    'advanced',
  );
  assert.deepEqual(
    f.nodes.map((n) => n.classList.contains('selected')),
    [true, false, true, false],
  );
  f.dom.window.close();
});

test('unsupported subjective and image questions can be skipped without changing answers; final submit remains untouched', async () => {
  for (const kind of ['text', 'image'])
    for (const last of [false, true]) {
      const f = fixture();
      if (kind === 'text') {
        f.document.querySelector('.type')!.textContent = '问答';
        f.document.querySelector('.answers')!.innerHTML =
          '<textarea>existing user answer</textarea>';
      } else
        f.document
          .querySelector('#richTextContent_100')!
          .shadowRoot!.append(f.document.createElement('img'));
      if (last) f.next.textContent = '提交本题型';
      const question = assertQuestionPage(f.context);
      assert.throws(() => assertAnswerPage(f.context));
      const before = f.document.querySelector('.answers')!.innerHTML;
      assert.equal(
        await advanceWithoutAnswer(
          f.context,
          question,
          new AbortController().signal,
        ),
        last ? 'section-end' : 'advanced',
      );
      assert.equal(f.document.querySelector('.answers')!.innerHTML, before);
      assert.equal(f.advances(), last ? 0 : 1);
      f.dom.window.close();
    }
});

test('fullscreen toolbar follows the fullscreen element and ignores synthetic page clicks', async () => {
  const f = fixture();
  const tool = mountTools(f.document, f.context.url);
  const host = f.document.querySelector('#autoffer-page-tools')!;
  const initial = host.shadowRoot!.querySelector('[role=status]')!.textContent;
  assert.ok(host.shadowRoot!.querySelector('[role=log]'));
  assert.equal(host.shadowRoot!.querySelectorAll('button').length, 3);
  assert.equal(
    host.shadowRoot!.querySelector<HTMLElement>('.question-navigation')!.hidden,
    true,
  );
  assert.ok(!host.shadowRoot!.textContent!.includes('结束并生成报告'));
  assert.ok(!host.shadowRoot!.querySelector('.row'));
  host.shadowRoot!.querySelector('button')!.click();
  assert.equal(
    host.shadowRoot!.querySelector('[role=status]')!.textContent,
    initial,
  );
  const full = f.document.createElement('div');
  f.document.body.append(full);
  Object.defineProperty(f.document, 'fullscreenElement', {
    value: full,
    configurable: true,
  });
  f.document.dispatchEvent(new f.dom.window.Event('fullscreenchange'));
  assert.equal(host.parentElement, full);
  assert.equal(tool.show(), true);
  tool.dispose();
  assert.equal(host.isConnected, false);
  assert.equal(tool.show(), false);
  f.dom.window.close();
});

test('next-section navigation uses only an explicit control, never a section-submit or final-submit button', async () => {
  for (const label of ['下一题型', '提交本题型', '交卷', '提交试卷']) {
    const f = fixture();
    f.next.textContent = label;
    if (label === '下一题型')
      f.next.addEventListener('click', () => {
        f.document.querySelector('.type')!.textContent = '多选';
      });
    assert.equal(
      await advanceSection(f.context, f.question, new AbortController().signal),
      label === '下一题型' ? 'advanced' : 'waiting',
    );
    assert.equal(f.advances(), label === '下一题型' ? 1 : 0);
    f.dom.window.close();
  }
});

test('hiding the page keeps recognition running; explicit stop still wins when it becomes visible', async () => {
  const f = fixture();
  // Empty question area: this check must not request a model or write answers.
  f.document.querySelector('.question-preview-container')!.remove();
  const tools = mountTools(f.document, f.context.url);
  tools.start();
  Object.defineProperty(f.document, 'hidden', {
    value: true,
    configurable: true,
  });
  f.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
  assert.equal(tools.getState().running, true);
  tools.stop();
  Object.defineProperty(f.document, 'hidden', {
    value: false,
    configurable: true,
  });
  f.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
  assert.equal(tools.getState().running, false);
  tools.dispose();
  f.dom.window.close();
});
