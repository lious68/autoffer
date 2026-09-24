import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import {
  createCodeEditor,
  resolveMonaco,
  type CodeModel,
} from '../src/platforms/nowcoder/code-editor';
import { scanPage } from '../src/platforms/registry';
import type { CodeResult, EditorTicket } from '../src/core/programming';

function fixture() {
  const dom = new JSDOM(
    readFileSync('tests/fixtures/nowcoder-acm.html', 'utf8'),
    { url: 'https://exam.nowcoder.com/cts/123/summary' },
  );
  const document = dom.window.document;
  for (const t of document.querySelectorAll<HTMLTemplateElement>(
    'template[data-shadow-fixture]',
  )) {
    t.parentElement!.attachShadow({ mode: 'open' }).append(
      t.content.cloneNode(true),
    );
    t.remove();
  }
  document.body.insertAdjacentHTML(
    'beforeend',
    `<input placeholder="请选择" value="Python3"><button id="run">自测运行</button><button id="submit">保存提交</button><button id="final">提交本题型</button><div class="el-table"><div><table><thead><tr>${['运行ID', '运行时间', '运行类型', '运行结果', '用例通过率'].map((t) => `<th>${t}</th>`).join('')}</tr></thead></table></div><div><table><tbody id="runs"></tbody></table></div></div>`,
  );
  let code = '# starter',
    version = 1,
    language = 'Python3',
    time = 0;
  const model: CodeModel = {
    getValue: () => code,
    setValue: (v) => {
      code = v;
      version++;
    },
    getVersionId: () => version,
    getLanguageId: () => 'python',
  };
  const node = document.querySelector('.monaco-editor')!;
  const run = createCodeEditor(
    document,
    () => ({ node, model, language }),
    () => time,
  );
  const prepare = () =>
    run({
      action: 'prepare',
      questionId: scanPage({ document, url: new URL(document.URL) })
        .questions[0]!.id,
    }) as EditorTicket;
  const row = (id: string, type: string, result: string, rate: string) => {
    document
      .querySelector('#runs')!
      .insertAdjacentHTML(
        'afterbegin',
        `<tr><td>${id}</td><td>12:00</td><td>${type}</td><td>${result}</td><td>${rate}</td></tr>`,
      );
  };
  return {
    dom,
    document,
    model,
    node,
    run,
    prepare,
    row,
    code: () => code,
    language: (v: string) => (language = v),
    now: (v: number) => (time = v),
  };
}

test('ACM fills, reads back, waits for fresh self-test and submission; never clicks final submit', (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  f.row('1', '自测运行', '运行成功', '100%'); // old success must never count
  const { token, language } = f.prepare();
  assert.equal(language, 'Python3');
  assert.equal(
    (f.run({ action: 'fill', token, code: 'print(1)' }) as CodeResult).state,
    'filled',
  );
  assert.equal(f.code(), 'print(1)');
  let runClicks = 0,
    submitClicks = 0,
    finalClicks = 0;
  f.document
    .querySelector('#run')!
    .addEventListener('click', () => runClicks++);
  f.document
    .querySelector('#submit')!
    .addEventListener('click', () => submitClicks++);
  f.document
    .querySelector('#final')!
    .addEventListener('click', () => finalClicks++);
  assert.throws(() => f.run({ action: 'submit', token }), /运行条件/);
  f.run({ action: 'run', token });
  assert.equal(
    (f.run({ action: 'poll', token }) as CodeResult).state,
    'running',
  );
  f.row('2', '自测运行', '运行成功', '100%');
  assert.equal(
    (f.run({ action: 'poll', token }) as CodeResult).state,
    'passed',
  );
  f.run({ action: 'submit', token });
  assert.equal(
    (f.run({ action: 'poll', token }) as CodeResult).state,
    'running',
  );
  f.row('3', '提交', '答案正确', '100%');
  assert.equal(
    (f.run({ action: 'poll', token }) as CodeResult).state,
    'accepted',
  );
  assert.deepEqual([runClicks, submitClicks, finalClicks], [1, 1, 0]);
  assert.throws(() => f.run({ action: 'submit', token }), /运行条件/);
});

test('self-test error is not completion, and failed self-tests cannot submit', (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  const { token } = f.prepare();
  f.run({ action: 'fill', token, code: 'print(1)' });
  f.run({ action: 'run', token });
  f.row('2', '自测运行', '执行出错', '0');
  assert.equal(
    (f.run({ action: 'poll', token }) as CodeResult).state,
    'failed',
  );
  assert.throws(() => f.run({ action: 'submit', token }), /运行条件/);
});

test('manual editing, language switch, question switch and cancellation all invalidate writes', (t) => {
  for (const mutation of ['edit', 'language', 'question', 'cancel', 'expire']) {
    const f = fixture();
    t.after(() => f.dom.window.close());
    const { token } = f.prepare();
    if (mutation === 'edit') f.model.setValue('# my code');
    if (mutation === 'language') f.language('C++');
    if (mutation === 'question')
      f.document.querySelector('.header .name')!.textContent =
        'another problem';
    if (mutation === 'cancel') f.run({ action: 'cancel', token });
    if (mutation === 'expire') f.now(300001);
    assert.throws(() => f.run({ action: 'fill', token, code: 'print(1)' }));
    assert.notEqual(f.code(), 'print(1)');
  }
});

test('readback mismatch and unknown run results never count as success', (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  const { token } = f.prepare();
  f.model.setValue = () => {};
  assert.throws(
    () => f.run({ action: 'fill', token, code: 'print(1)' }),
    /回读不一致/,
  );
  const g = fixture();
  t.after(() => g.dom.window.close());
  const ticket = g.prepare();
  g.run({ action: 'fill', token: ticket.token, code: 'print(1)' });
  g.run({ action: 'run', token: ticket.token });
  g.row('4', '自测运行', '编译成功', '0%');
  assert.equal(
    (g.run({ action: 'poll', token: ticket.token }) as CodeResult).state,
    'failed',
  );
});

test('Monaco resolver binds the sole visible editor even with hidden example models', (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  const hidden = f.document.createElement('div');
  hidden.className = 'monaco-editor';
  hidden.hidden = true;
  f.document.body.append(hidden);
  Object.assign(f.dom.window, {
    monaco: {
      editor: {
        getModels: () => [f.model, {}],
        getEditors: () => [
          { getDomNode: () => hidden, getModel: () => ({}) },
          { getDomNode: () => f.node, getModel: () => f.model },
        ],
      },
    },
  });
  assert.equal(resolveMonaco(f.document).model, f.model);
  assert.equal(resolveMonaco(f.document).language, 'Python3');
  Object.assign(f.dom.window, {
    monaco: { editor: { getModels: () => [f.model, {}] } },
  });
  assert.throws(() => resolveMonaco(f.document), /唯一定位/);
});

test('example questions can never prepare an editor', (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  f.document.querySelector('.header')!.innerHTML =
    '<div class="example-tag">例题</div><span class="defaultScore">不计分</span>';
  assert.throws(() => f.prepare(), /正式编程题/);
});
