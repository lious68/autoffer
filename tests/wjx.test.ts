import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import wjx from '../src/platforms/wjx';
import { entries, cursorAttribute } from '../src/platforms/wjx/extractor';
import { createPlatformRuntime } from '../src/platforms/runtime';
import { scanPage } from '../src/platforms/registry';
import { inferenceIssue, type Suggestion } from '../src/core/schema';
import { assertPlatformContract } from './platform-contract';

function setup() {
  const document = new JSDOM(
    readFileSync(new URL('./fixtures/wjx.html', import.meta.url), 'utf8'),
    { url: 'https://ks.wjx.com/vm/sample.aspx' },
  ).window.document;
  const context = { document, url: new URL(document.URL) };
  for (const label of document.querySelectorAll<HTMLElement>('.label')) {
    label.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 30 }) as DOMRect;
    label.addEventListener('click', () => {
      const row = label.parentElement!;
      const input = row.querySelector<HTMLInputElement>('input')!;
      if (input.type === 'radio') {
        for (const other of row.parentElement!.querySelectorAll<HTMLInputElement>(
          'input',
        ))
          other.checked = false;
        input.checked = true;
      } else input.checked = !input.checked;
      for (const sibling of row.parentElement!.children)
        sibling
          .querySelector('a')!
          .classList.toggle(
            'jqchecked',
            sibling.querySelector<HTMLInputElement>('input')!.checked,
          );
    });
  }
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => {
      const topic =
        document.querySelector('form')!.getAttribute(cursorAttribute) ?? '2';
      return document.getElementById(`div${topic}`)!.querySelector('.label');
    },
    configurable: true,
  });
  return {
    context,
    document,
    runtime: createPlatformRuntime(context),
    question: () => scanPage(context).questions[0]!,
  };
}
function suggestion(f: ReturnType<typeof setup>, ids = ['o1']): Suggestion {
  return {
    questionId: f.question().id,
    provider: 'test',
    model: 'fixture',
    selectedIds: ids,
    confidence: 0.95,
    needsReview: false,
    probabilities: {},
    probabilityKind: 'unavailable',
    notices: [],
  };
}

test('WJX identifies mobile exam, reads one cursor question and excludes entered personal values', () => {
  const f = setup();
  assertPlatformContract(wjx, f.context);
  assert.equal(entries(f.context).length, 5);
  assert.equal(f.question().kind, 'single');
  assert.equal(f.runtime.navigation().length, 5);
  assert.ok(
    !JSON.stringify(entries(f.context).map((e) => e.question)).includes(
      'PRIVATE_NAME',
    ),
  );
  assert.equal(
    wjx.matches({
      ...f.context,
      url: new URL('https://ks.wjx.com.evil.invalid/vm/sample.aspx'),
    }),
    false,
  );
  assert.equal(
    wjx.matches({
      ...f.context,
      url: new URL('https://ks.wjx.com/result.aspx'),
    }),
    false,
  );
});

test('cursor survives new runtime, skipped choice stays untouched, last question never submits', async () => {
  const f = setup();
  let submits = 0;
  f.document
    .getElementById('ctlNext')!
    .addEventListener('click', () => submits++);
  const before = [
    ...f.document.querySelectorAll<HTMLInputElement>('input[type=radio]'),
  ].map((i) => i.checked);
  await f.runtime.skip(f.question(), new AbortController().signal);
  assert.equal(f.question().kind, 'multiple');
  assert.equal(
    createPlatformRuntime(f.context).navigation()[1]!.id,
    f.question().id,
  );
  assert.deepEqual(
    [...f.document.querySelectorAll<HTMLInputElement>('input[type=radio]')].map(
      (i) => i.checked,
    ),
    before,
  );
  f.runtime.selectQuestion(f.runtime.navigation().at(-1)!.id);
  assert.equal(
    await f.runtime.skip(f.question(), new AbortController().signal),
    'section-end',
  );
  assert.equal(submits, 0);
});

test('single choice verifies input and indicator, advances locally, preserves personal fields', async () => {
  const f = setup();
  assert.equal(
    await f.runtime.apply(
      f.question(),
      suggestion(f),
      new AbortController().signal,
    ),
    'advanced',
  );
  assert.equal(
    f.document.querySelector<HTMLInputElement>('#q2_1')!.checked,
    true,
  );
  assert.equal(
    f.document.querySelector<HTMLInputElement>('#q2_2')!.checked,
    false,
  );
  assert.equal(
    f.document.querySelector<HTMLInputElement>('#q1')!.value,
    'PRIVATE_NAME',
  );
  assert.equal(f.question().kind, 'multiple');
});

test('multi-select removes previous answers and verifies exact set', async () => {
  const f = setup();
  f.runtime.selectQuestion(f.runtime.navigation()[1]!.id);
  // Each distinct label has a corresponding hit target.
  for (const [i, label] of [
    ...f.document.querySelectorAll<HTMLElement>('#div3 .label'),
  ].entries())
    label.getBoundingClientRect = () =>
      ({ left: i * 100, top: 0, width: 90, height: 30 }) as DOMRect;
  Object.defineProperty(f.document, 'elementFromPoint', {
    value: (x: number) =>
      f.document.querySelectorAll('#div3 .label')[Math.floor(x / 100)],
  });
  await f.runtime.apply(
    f.question(),
    suggestion(f, ['o1', 'o3']),
    new AbortController().signal,
  );
  assert.deepEqual(
    [...f.document.querySelectorAll<HTMLInputElement>('#div3 input')].map(
      (i) => i.checked,
    ),
    [true, false, true],
  );
});

test('stale answers, cancelled jobs, occlusion and disabled options do not write', async () => {
  const f = setup();
  const oldQuestion = f.question(),
    oldSuggestion = suggestion(f);
  f.runtime.selectQuestion(f.runtime.navigation()[1]!.id);
  await assert.rejects(
    f.runtime.apply(oldQuestion, oldSuggestion, new AbortController().signal),
    /已经变化/,
  );
  f.runtime.selectQuestion(f.runtime.navigation()[0]!.id);
  await assert.rejects(
    f.runtime.apply(f.question(), suggestion(f), AbortSignal.abort()),
    /停止/,
  );
  Object.defineProperty(f.document, 'elementFromPoint', {
    value: () => f.document.body,
    configurable: true,
  });
  await assert.rejects(
    f.runtime.apply(f.question(), suggestion(f), new AbortController().signal),
    /遮挡/,
  );
  f.document.querySelector<HTMLInputElement>('#q2_1')!.disabled = true;
  await assert.rejects(
    f.runtime.apply(f.question(), suggestion(f), new AbortController().signal),
    /不可操作/,
  );
  assert.equal(
    f.document.querySelector<HTMLInputElement>('#q2_1')!.checked,
    false,
  );
});

test('fill blanks and subjective answers remain manual, unknown surveys are not knowledge questions', () => {
  const f = setup();
  f.runtime.selectQuestion(f.runtime.navigation()[2]!.id);
  assert.equal(f.question().classification?.format, 'fill-blank');
  assert.deepEqual(f.runtime.capabilities(f.question()), {
    answer: false,
    advance: true,
  });
  const survey = entries({
    ...f.context,
    url: new URL('https://www.wjx.cn/vm/sample.aspx'),
  });
  assert.match(inferenceIssue(survey[0]!.question)!, /意图/);
  const before = f.question().id;
  f.document.querySelector<HTMLInputElement>('#q4')!.value = 'private draft';
  assert.equal(f.question().id, before);
});

test('hidden current question does not fall through to another question; images and missing options are detected', () => {
  const f = setup();
  f.runtime.selectQuestion(f.runtime.navigation()[0]!.id);
  f.document.getElementById('div2')!.hidden = true;
  assert.equal(scanPage(f.context).questions.length, 0);
  f.document.querySelector('form')!.removeAttribute(cursorAttribute);
  f.document.getElementById('div2')!.hidden = false;
  f.document
    .querySelector('#div2 .topichtml')!
    .append(f.document.createElement('img'));
  assert.equal(f.question().hasVisual, true);
  f.document.querySelector('#div2 .label')!.textContent = '';
  assert.match(inferenceIssue(f.question())!, /不完整/);
});
