import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import nowcoder from '../src/platforms/nowcoder';
import { scanPage } from '../src/platforms/registry';
import { unsupportedReason } from '../src/core/schema';

const fixture = readFileSync(
  new URL('./fixtures/nowcoder-directory.html', import.meta.url),
  'utf8',
);
const context = () => ({
  document: new JSDOM(fixture).window.document,
  url: new URL('https://exam.nowcoder.com/cts/123/summary'),
});

test('Nowcoder directory gives an actionable diagnostic and collects no candidate fields', () => {
  const page = context();
  const before = page.document.body.innerHTML;
  const result = scanPage(page);
  assert.equal(result.platform?.id, 'nowcoder');
  assert.equal(result.questions.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /试卷目录/);
  assert.ok(!JSON.stringify(result).includes('private-placeholder'));
  assert.equal(page.document.body.innerHTML, before);
});

test('Nowcoder adapter only matches the observed enterprise origin and CTS route', () => {
  for (const url of [
    'https://exam.nowcoder.com.evil.test/cts/123/summary',
    'https://www.nowcoder.com/practice/123',
    'https://exam.nowcoder.com/profile',
    'http://exam.nowcoder.com/cts/123/summary',
  ])
    assert.equal(nowcoder.matches({ ...context(), url: new URL(url) }), false);
});

function choiceContext(mode: ShadowRootMode = 'open') {
  const html = readFileSync(
    new URL('./fixtures/nowcoder-choice.html', import.meta.url),
    'utf8',
  );
  const document = new JSDOM(html).window.document;
  for (const template of document.querySelectorAll<HTMLTemplateElement>(
    'template[data-shadow-fixture]',
  )) {
    const host = template.parentElement!;
    host.attachShadow({ mode }).append(template.content.cloneNode(true));
    template.remove();
  }
  return {
    document,
    url: new URL('https://exam.nowcoder.com/cts/123/summary#4/test'),
  };
}

test('reads complete Nowcoder stem and all choices from open shadow roots without candidate data', () => {
  const page = choiceContext();
  const before = page.document.body.innerHTML;
  const result = scanPage(page);
  assert.equal(result.questions.length, 1);
  const question = result.questions[0]!;
  assert.equal(question.kind, 'single');
  assert.equal(
    question.stem,
    '通知：活动仅在周六开放。 下列哪项说法不符合通知？',
  );
  assert.deepEqual(
    question.options.map((option) => option.label),
    ['A', 'B', 'C', 'D'],
  );
  assert.equal(question.options[1]?.text, '每天都可以参加活动。');
  assert.equal(unsupportedReason(question), null);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_CANDIDATE'));
  assert.ok(!JSON.stringify(result).includes('请返回全屏'));
  assert.ok(!JSON.stringify(result).includes(':host'));
  assert.equal(page.document.body.innerHTML, before);
});

test('multiple-choice mapping is covered by a synthetic layout variant', () => {
  for (const type of [
    '多选',
    '多选题',
    '不定项',
    '不定项选择',
    '不定项选择题',
  ]) {
    const page = choiceContext();
    page.document.querySelector('.type')!.textContent = type;
    assert.equal(scanPage(page).questions[0]?.kind, 'multiple');
  }
});

test('observed indefinite-choice header and decorative check icons do not contaminate question text or trigger image blocking', () => {
  const page = choiceContext();
  page.document.querySelector('.type')!.textContent = '不定项';
  page.document
    .querySelector('.header')!
    .insertAdjacentHTML('beforeend', '<div role="alert">测试计分提示</div>');
  page.document
    .querySelector('.order-content')!
    .insertAdjacentHTML('beforeend', '<div role="alert">测试计分提示</div>');
  for (const option of page.document.querySelectorAll('.option-item'))
    option.insertAdjacentHTML(
      'beforeend',
      '<span class="mark"><span class="ncicon" aria-label="Xuanzhong00"><svg aria-hidden="true"><path d="M0 0"></path></svg></span></span>',
    );
  const q = scanPage(page).questions[0]!;
  assert.equal(q.kind, 'multiple');
  assert.equal(q.typeLabel, '不定项');
  assert.equal(q.hasVisual, false);
  assert.equal(unsupportedReason(q), null);
  assert.ok(!q.stem.includes('计分提示'));
});

test('two-option judgement shares single-choice logic; non-choice types expose no answer fields and remain unsupported', () => {
  for (const type of ['判断', '判断题', '是非题']) {
    const page = choiceContext();
    page.document.querySelector('.type')!.textContent = type;
    for (const node of [
      ...page.document.querySelectorAll('.option-item'),
    ].slice(2))
      node.remove();
    const q = scanPage(page).questions[0]!;
    assert.equal(q.kind, 'single');
    assert.equal(q.classification?.format, 'true-false');
    assert.equal(q.classification?.domain, 'unknown');
    assert.equal(unsupportedReason(q), null);
  }
  const bad = choiceContext();
  bad.document.querySelector('.type')!.textContent = '判断';
  assert.ok(unsupportedReason(scanPage(bad).questions[0]!));
  for (const type of ['填空', '问答', '简答题', '编程']) {
    const page = choiceContext();
    page.document.querySelector('.type')!.textContent = type;
    page.document.querySelector('.answers')!.innerHTML =
      '<textarea>PRIVATE_USER_ANSWER</textarea>';
    const q = scanPage(page).questions[0]!;
    assert.equal(q.kind, 'text');
    assert.equal(q.typeLabel, type);
    assert.equal(
      q.classification?.format,
      type === '填空'
        ? 'fill-blank'
        : type === '编程'
          ? 'programming'
          : 'subjective',
    );
    assert.deepEqual(q.options, []);
    assert.match(unsupportedReason(q)!, /暂不自动作答/);
    assert.ok(!JSON.stringify(q).includes('PRIVATE_USER_ANSWER'));
  }
});

test('Python code preserves indentation and newlines across syntax spans and open shadow roots', () => {
  const page = choiceContext();
  const root = page.document.querySelector('#richTextContent_100')!.shadowRoot!;
  root.innerHTML =
    '<pre>def <span>sample</span>(value):\n&nbsp;&nbsp;&nbsp;&nbsp;if value:\n&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;return value<br>print(sample(7))<span hidden>HIDDEN</span></pre><p>请选择输出。</p>';
  const question = scanPage(page).questions[0]!;
  assert.ok(
    question.stem.includes(
      'def sample(value):\n    if value:\n        return value\nprint(sample(7))',
    ),
  );
  assert.ok(!question.stem.includes('HIDDEN'));
  assert.ok(question.stem.includes('请选择输出。'));
  const id = question.id;
  root.querySelector('pre')!.firstChild!.textContent = 'def  ';
  assert.notEqual(scanPage(page).questions[0]!.id, id);
});

test('visuals inside a rich-text shadow root block text-only inference', () => {
  const page = choiceContext();
  const root = page.document.querySelector('#richTextContent_102')!.shadowRoot!;
  root.append(page.document.createElement('img'));
  const question = scanPage(page).questions[0]!;
  assert.equal(question.hasVisual, true);
  assert.match(unsupportedReason(question)!, /图片/);
});

test('hidden shadow text and styles are excluded while negation is preserved', () => {
  const page = choiceContext();
  const root = page.document.querySelector('#richTextContent_100')!.shadowRoot!;
  const hidden = page.document.createElement('span');
  hidden.hidden = true;
  hidden.textContent = 'HIDDEN_SECRET';
  root.append(hidden);
  const question = scanPage(page).questions[0]!;
  assert.ok(!question.stem.includes('HIDDEN_SECRET'));
  assert.ok(question.stem.includes('不符合'));
});

test('missing/closed shadow roots and duplicate labels produce diagnostics, not guessed content', () => {
  const closed = scanPage(choiceContext('closed'));
  assert.equal(closed.questions.length, 0);
  assert.ok(closed.warnings.length > 0);
  const missing = choiceContext();
  missing.document
    .querySelector('#richTextContent_102')!
    .shadowRoot!.replaceChildren();
  assert.ok(unsupportedReason(scanPage(missing).questions[0]!));
  const duplicate = choiceContext();
  duplicate.document.querySelectorAll('.option-order')[1]!.textContent = 'A';
  assert.match(scanPage(duplicate).questions[0]!.warnings.join(), /标号/);
});

test('SPA question number and content changes invalidate the prior identity', () => {
  const page = choiceContext();
  const id = scanPage(page).questions[0]!.id;
  page.document.querySelector('.tw-text-size-head-pure')!.textContent = '2.';
  assert.notEqual(scanPage(page).questions[0]!.id, id);
  const nextId = scanPage(page).questions[0]!.id;
  page.document
    .querySelector('#richTextContent_101')!
    .shadowRoot!.querySelector('div')!.textContent = '更换后的选项';
  assert.notEqual(scanPage(page).questions[0]!.id, nextId);
});

test('unknown types, multiple visible containers and unmapped material fail safely', () => {
  const unknown = choiceContext();
  unknown.document.querySelector('.type')!.textContent = '未知新题型';
  assert.equal(scanPage(unknown).questions.length, 0);
  const ambiguous = choiceContext();
  ambiguous.document.body.append(
    ambiguous.document
      .querySelector('.question-preview-container')!
      .cloneNode(true),
  );
  assert.match(scanPage(ambiguous).warnings.join(), /多个/);
  const material = choiceContext();
  const extra = material.document.createElement('div');
  extra.className = 'rich-text';
  extra.textContent = '其他材料';
  material.document.querySelector('.body')!.append(extra);
  assert.match(scanPage(material).questions[0]!.warnings.join(), /补充材料/);
});
