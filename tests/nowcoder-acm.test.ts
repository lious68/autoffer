import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { scanPage } from '../src/platforms/registry';
import { inferenceIssue } from '../src/core/schema';
import { solvePolicy } from '../src/solvers/policy';
import { routeFor } from '../src/core/routing';
import { modelPresets } from '../src/core/connections';

function fixture() {
  const dom = new JSDOM(
    readFileSync('tests/fixtures/nowcoder-acm.html', 'utf8'),
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
  return {
    dom,
    document,
    url: new URL('https://exam.nowcoder.com/cts/123/summary'),
  };
}

test('ACM extraction reads constraints, descriptions and multiple examples without an ordinary type label', (t) => {
  const page = fixture();
  t.after(() => page.dom.window.close());
  const before = page.document.body.innerHTML;
  const result = scanPage(page);
  assert.equal(result.questions.length, 1);
  const q = result.questions[0]!;
  assert.equal(q.classification?.format, 'programming');
  assert.equal(q.kind, 'text');
  assert.match(q.stem, /时间限制：1秒/);
  assert.match(q.stem, /空间限制：32MB/);
  assert.match(q.stem, /计算每组两个整数的和/);
  assert.match(q.material, /输入描述/);
  assert.match(q.material, /输出描述/);
  assert.ok(q.material.includes('2\n1 2\n3 4'));
  assert.ok(q.material.includes('3\n7'));
  assert.match(q.material, /示例 2/);
  assert.match(q.material, /各组独立计算/);
  assert.ok(!JSON.stringify(q).includes('PRIVATE_'));
  assert.ok(!q.material.includes('复制'));
  assert.equal(q.hasVisual, false);
  assert.equal(inferenceIssue(q), null);
  assert.equal(solvePolicy(q).mode, 'reference');
  assert.equal(
    routeFor(q, {
      jev: { settings: modelPresets.jev, apiKey: 'fake' },
      chat: { settings: modelPresets.chat, apiKey: 'fake' },
    }),
    'chat',
  );
  assert.equal(page.document.body.innerHTML, before);
});

test('sample and constraint changes change ACM identity, but editor changes do not', (t) => {
  const page = fixture();
  t.after(() => page.dom.window.close());
  const first = scanPage(page).questions[0]!.id;
  page.document.querySelector('.monaco-editor')!.textContent =
    'PRIVATE_DIFFERENT_CODE';
  assert.equal(scanPage(page).questions[0]!.id, first);
  page.document.querySelector<HTMLElement>(
    '[style*="pre-wrap"]',
  )!.textContent += '\n6 7';
  const second = scanPage(page).questions[0]!.id;
  assert.notEqual(second, first);
  [...page.document.querySelectorAll('div')]
    .find((el) => el.textContent?.trim() === '时间限制：1秒')!
    .replaceChildren('时间限制：2秒');
  assert.notEqual(scanPage(page).questions[0]!.id, second);
});

test('incomplete descriptions and collapsed examples block model requests', (t) => {
  const page = fixture();
  t.after(() => page.dom.window.close());
  page.document
    .querySelectorAll('.rich-text')[1]!
    .querySelector('div')!
    .shadowRoot!.replaceChildren();
  const q = scanPage(page).questions[0]!;
  assert.match(q.warnings.join(), /输入描述/);
  assert.ok(inferenceIssue(q));
  page.document.querySelector<HTMLElement>('[style*="pre-wrap"]')!.hidden =
    true;
  assert.match(scanPage(page).questions[0]!.warnings.join(), /示例 1/);
});

test('ordinary prose, hidden stale questions and multiple live roots cannot produce a guessed ACM question', (t) => {
  const page = fixture();
  t.after(() => page.dom.window.close());
  const root = page.document.querySelector('.question-preview-container')!;
  const old = root.cloneNode(true) as HTMLElement;
  old.hidden = true;
  page.document.body.append(old);
  assert.equal(scanPage(page).questions.length, 1);
  old.hidden = false;
  assert.equal(scanPage(page).questions.length, 0);
  old.remove();
  root.innerHTML =
    '<div class="header"><span class="type">未知题型</span></div><p>请讨论输入描述和输出描述的区别。</p>';
  assert.equal(scanPage(page).questions.length, 0);
});

test('the real example markers distinguish two examples from the scored programming problem', (t) => {
  const page = fixture();
  t.after(() => page.dom.window.close());
  const formal = page.document.querySelector<HTMLElement>(
    '.question-preview-container',
  )!;
  const examples = [1, 2].map((index) => {
    const example = formal.cloneNode(true) as HTMLElement;
    example.querySelector('.header')!.innerHTML =
      `<div class="name">ACM 输入输出规范示例 ${index}</div><div class="example-tag">例题</div><span class="defaultScore">不计分</span>`;
    // Reconstruct independent open shadows; cloning alone intentionally does not copy them.
    example.querySelectorAll('.rich-text').forEach((node, i) => {
      node.textContent = i === 0 ? '示例题干' : '示例输入说明';
    });
    page.document.body.append(example);
    return example;
  });
  for (const current of [...examples, formal]) {
    for (const root of [...examples, formal])
      root.style.display = root === current ? '' : 'none';
    const scan = scanPage(page);
    assert.equal(scan.questions.length, 1);
    const question = scan.questions[0]!;
    assert.equal(question.isExample, current !== formal);
    assert.equal(
      solvePolicy(question).mode,
      current === formal ? 'reference' : 'manual',
    );
    if (current !== formal) assert.match(inferenceIssue(question)!, /不计分/);
  }
});
