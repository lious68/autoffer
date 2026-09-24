import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { scanPage, platforms } from '../src/platforms/registry';
import { defineTemplate } from '../src/platforms/template';
import { unsupportedReason } from '../src/core/schema';
import { demoDocument, demoScan } from './helpers';

test('demo fixture extracts all supported structures, shared material and visual boundaries', () => {
  const scan = demoScan();
  assert.equal(scan.platform?.id, 'demo');
  assert.equal(scan.questions.length, 5);
  assert.deepEqual(
    scan.questions.map((question) => question.kind),
    ['single', 'multiple', 'single', 'personal', 'text'],
  );
  assert.equal(scan.warnings.length, 0);
  const single = scan.questions.find((question) => question.kind === 'single')!;
  const multiple = scan.questions.find(
    (question) => question.kind === 'multiple',
  )!;
  assert.equal(single.options[1]?.text, '周六可以使用一层阅览室。');
  assert.match(single.material, /只开放一层/);
  assert.match(multiple.material, /报名截止后/);
  assert.equal(unsupportedReason(single), null);
  assert.ok(
    unsupportedReason(scan.questions.find((question) => question.hasVisual)!),
  );
  assert.ok(
    unsupportedReason(
      scan.questions.find((question) => question.kind === 'personal')!,
    ),
  );
  assert.ok(
    unsupportedReason(
      scan.questions.find((question) => question.kind === 'text')!,
    ),
  );
});

test('exact host and DOM marker are both required', () => {
  for (const url of [
    'https://localhost.attacker.test/demo.html',
    'https://51job.com/demo.html',
    'http://localhost/unrelated',
  ]) {
    assert.equal(
      scanPage({ document: demoDocument(), url: new URL(url) }).platform,
      null,
    );
  }
  const document = demoDocument();
  document.body.removeAttribute('data-autoffer-demo');
  assert.equal(
    scanPage({ document, url: new URL('http://localhost/demo.html') }).platform,
    null,
  );
});

test('question identity is stable but changes when material or options change', () => {
  const document = demoDocument();
  const context = { document, url: new URL('http://localhost/demo.html') };
  const first = scanPage(context).questions[0]!;
  assert.equal(first.id, scanPage(context).questions[0]!.id);
  document.querySelector('[data-material]')!.textContent = '替换后的材料';
  assert.notEqual(first.id, scanPage(context).questions[0]!.id);
  assert.equal(document.querySelectorAll('input:checked').length, 0);
});

test('hidden content and scripts do not become question text', () => {
  const document = demoDocument();
  const stem = document.querySelector('[data-stem]')!;
  const original = stem.textContent;
  for (const markup of [
    '<span hidden>秘密</span>',
    '<span style="display:none">秘密</span>',
    '<script>秘密</script>',
    '<span aria-hidden="true">秘密</span>',
  ]) {
    stem.insertAdjacentHTML('beforeend', markup);
  }
  assert.equal(
    scanPage({ document, url: new URL('http://localhost/demo.html') })
      .questions[0]?.stem,
    original,
  );
});

test('missing option text is surfaced and prevents inference', () => {
  const document = demoDocument();
  document.querySelector('[data-text]')!.textContent = '';
  const question = scanPage({
    document,
    url: new URL('http://localhost/demo.html'),
  }).questions[0]!;
  assert.ok(question.warnings.length > 0);
  assert.ok(unsupportedReason(question));
});

test('ambiguous adapter matches and invalid selectors fail visibly', () => {
  const context = {
    document: demoDocument(),
    url: new URL('http://localhost/demo.html'),
  };
  assert.match(
    scanPage(context, [platforms[0]!, platforms[0]!]).warnings[0]!,
    /多个平台/,
  );
  const broken = defineTemplate({
    meta: platforms[0]!.meta,
    match: { hosts: ['localhost'], pathPrefix: '/', marker: '[' },
    rules: [],
  });
  assert.match(scanPage(context, [broken]).warnings[0]!, /解析失败/);
});

test('a matched but empty page gives a diagnostic instead of success', () => {
  const document = new JSDOM('<body data-autoffer-demo="v1"></body>').window
    .document;
  const result = scanPage({
    document,
    url: new URL('http://localhost/demo.html'),
  });
  assert.equal(result.questions.length, 0);
  assert.match(result.warnings[0]!, /没有找到题目/);
});
