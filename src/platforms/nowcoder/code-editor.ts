import { AppError } from '../../core/errors';
import type {
  CodeCommand,
  CodeResult,
  EditorTicket,
} from '../../core/programming';
import { isAcm } from '../../core/programming';
import { semanticQuestion } from '../../core/schema';
import { visible } from '../template';
import nowcoder from './extractor';

export interface CodeModel {
  getValue(): string;
  setValue(code: string): void;
  getLanguageId(): string;
  getVersionId(): number;
}
export interface EditorHandle {
  node: Element;
  model: CodeModel;
  language: string;
}

/** Read only the visible editor. Never select an arbitrary model from hidden examples. */
export function resolveMonaco(document: Document): EditorHandle {
  const scope = document.defaultView as unknown as {
    monaco?: {
      editor?: {
        getEditors?(): Array<{
          getDomNode(): Element | null;
          getModel(): CodeModel | null;
        }>;
        getModels?(): CodeModel[];
      };
    };
  };
  const api = scope.monaco?.editor;
  const nodes = [...document.querySelectorAll('.monaco-editor')].filter(
    visible,
  );
  const editors = api?.getEditors?.().filter((e) => {
    const node = e.getDomNode();
    return node && node.isConnected && visible(node);
  });
  const models = api?.getModels?.();
  const node =
    editors?.length === 1
      ? editors[0]!.getDomNode()
      : nodes.length === 1
        ? nodes[0]
        : null;
  const model =
    editors?.length === 1
      ? editors[0]!.getModel()
      : !editors && models?.length === 1
        ? models[0]
        : null;
  if (!node || !model || nodes.length !== 1)
    throw new AppError(
      'CODE_EDITOR',
      '无法唯一定位当前 Monaco 编辑器，未写入代码。',
    );
  const labels = [
    ...document.querySelectorAll<HTMLInputElement>(
      'input[placeholder="请选择"]',
    ),
  ]
    .filter(visible)
    .map((n) => n.value.trim())
    .filter((v) =>
      /^(?:Python[23]|pypy[23]|C\+\+|C|Java|JavaScript|Go|Rust)(?:\([^)]*\))?$/.test(
        v,
      ),
    );
  const languageId = model.getLanguageId();
  const label = labels.length === 1 ? labels[0] : undefined;
  const expected = label?.replace(/\([^)]*\)/g, '');
  const modes: Record<string, string[]> = {
    Python2: ['python'],
    Python3: ['python'],
    pypy2: ['python'],
    pypy3: ['python'],
    'C++': ['cpp'],
    C: ['c', 'cpp'],
    Java: ['java'],
    JavaScript: ['javascript'],
    Go: ['go'],
    Rust: ['rust'],
  };
  if (expected && !modes[expected]?.includes(languageId))
    throw new AppError(
      'CODE_LANGUAGE',
      '语言选择器与编辑器尚未同步，未请求模型。',
    );
  const language = label ?? languageId;
  if (!language || (languageId === 'python' && !label))
    throw new AppError('CODE_LANGUAGE', '未确认 Python 版本，未请求模型。');
  return { node, model, language };
}

interface RunRow {
  id: string;
  type: string;
  result: string;
  rate: string;
}
/** Nowcoder's observed split header/body tables. Read only its run-history table. */
export function readCodeRuns(document: Document): RunRow[] {
  const headers = [...document.querySelectorAll('table')]
    .filter(visible)
    .filter((table) => {
      const labels = [...table.querySelectorAll('th')].map((n) =>
        n.textContent?.trim(),
      );
      return ['运行ID', '运行类型', '运行结果', '用例通过率'].every((label) =>
        labels.includes(label),
      );
    });
  if (headers.length !== 1) return [];
  const header = headers[0]!;
  const labels = [...header.querySelectorAll('th')].map((n) =>
    n.textContent?.trim(),
  );
  // Element UI splits header and body into sibling table wrappers.
  const tableRoot = header.closest('.el-table') ?? header;
  return [...tableRoot.querySelectorAll('tbody tr')]
    .filter(visible)
    .flatMap((row) => {
      const cells = [...row.querySelectorAll('td')].map(
        (n) => n.textContent?.trim() ?? '',
      );
      const value = (label: string) => cells[labels.indexOf(label)] ?? '';
      const id = value('运行ID');
      return /^\d+$/.test(id)
        ? [
            {
              id,
              type: value('运行类型'),
              result: value('运行结果'),
              rate: value('用例通过率'),
            },
          ]
        : [];
    });
}

export function createCodeEditor(
  document: Document,
  resolve = () => resolveMonaco(document),
  now = Date.now,
  active = () => true,
) {
  let ticket:
    | {
        token: string;
        question: string;
        node: Element;
        model: CodeModel;
        language: string;
        version: number;
        code?: string;
        expires: number;
        stage:
          | 'prepared'
          | 'filled'
          | 'running'
          | 'passed'
          | 'submitted'
          | 'accepted'
          | 'failed';
        baseline: Set<string>;
        runId?: string;
        started?: number;
      }
    | undefined;
  const fail = (message: string): never => {
    throw new AppError('CODE_ACTION', message);
  };
  function question() {
    const context = { document, url: new URL(document.URL) };
    if (!nowcoder.matches(context))
      return fail('当前页面不是已适配的牛客 ACM 页面。');
    const scan = nowcoder.extract(context);
    const q = scan.questions[0];
    if (scan.questions.length !== 1 || !q || !isAcm(q) || q.warnings.length)
      return fail('当前不是唯一、完整的正式编程题，未操作编辑器。');
    return q;
  }
  function button(text: string) {
    const nodes = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].filter((n) => visible(n) && n.textContent?.trim() === text);
    if (
      nodes.length !== 1 ||
      nodes[0]!.disabled ||
      nodes[0]!.getAttribute('aria-disabled') === 'true'
    )
      return fail(`未找到可用的“${text}”按钮，未执行操作。`);
    return nodes[0]!;
  }
  return (command: CodeCommand): EditorTicket | CodeResult | null => {
    if (command.action === 'cancel') {
      if (ticket?.token === command.token) ticket = undefined;
      return null;
    }
    if (!active()) return fail('作答已停止，未操作编辑器。');
    if (
      [
        ...document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"], .el-message-box__wrapper',
        ),
      ].some(visible)
    )
      return fail('页面存在弹窗，未操作代码。');
    const q = question();
    if (command.action === 'prepare') {
      if (q.id !== command.questionId) return fail('题目已变化。');
      const editor = resolve();
      ticket = {
        ...editor,
        token: crypto.randomUUID(),
        question: JSON.stringify(semanticQuestion(q)),
        version: editor.model.getVersionId(),
        expires: now() + 300_000,
        stage: 'prepared',
        baseline: new Set(),
      };
      return { token: ticket.token, language: ticket.language };
    }
    const t = ticket;
    if (!t || command.token !== t.token || now() > t.expires)
      return fail('代码操作已失效，请重新开始。');
    const editor = resolve();
    if (
      JSON.stringify(semanticQuestion(q)) !== t.question ||
      editor.node !== t.node ||
      editor.model !== t.model ||
      editor.language !== t.language
    )
      return fail('题目、语言或编辑器已变化，旧代码不会写入或提交。');
    if (
      editor.model.getVersionId() !== t.version ||
      (t.code !== undefined && editor.model.getValue() !== t.code)
    )
      return fail('编辑器内容已被修改，已保留当前代码。');
    if (command.action === 'fill') {
      if (t.stage !== 'prepared') return fail('本次代码已处理，不重复回填。');
      const code = command.code
        .replace(/^```[^\n]*\n([\s\S]*?)\n```\s*$/, '$1')
        .replace(/\r\n/g, '\n')
        .trim();
      if (!code || code.length > 20000 || code.includes('```'))
        return fail('模型返回的代码格式无效。');
      editor.model.setValue(code);
      if (editor.model.getValue().replace(/\r\n/g, '\n') !== code)
        return fail('代码回读不一致，未执行或提交。');
      t.version = editor.model.getVersionId();
      t.code = editor.model.getValue();
      t.stage = 'filled';
      return { state: 'filled', message: '代码已回填并确认。' };
    }
    if (command.action === 'run' || command.action === 'submit') {
      const submit = command.action === 'submit';
      if (t.stage !== (submit ? 'passed' : 'filled'))
        return fail('当前代码尚未达到运行条件。');
      const control = button(submit ? '保存提交' : '自测运行');
      t.baseline = new Set(readCodeRuns(document).map((row) => row.id));
      delete t.runId;
      t.started = now();
      t.stage = submit ? 'submitted' : 'running';
      control.click();
      return {
        state: 'running',
        message: submit ? '已提交本题，等待判题。' : '已启动自测，等待结果。',
      };
    }
    if (t.stage === 'accepted')
      return { state: 'accepted', message: '本题提交通过。' };
    if (t.stage === 'passed') return { state: 'passed', message: '自测通过。' };
    if (!['running', 'submitted'].includes(t.stage))
      return fail('没有正在等待的代码运行。');
    const rows = readCodeRuns(document).filter(
      (row) => !t.baseline.has(row.id),
    );
    const targetType =
      t.stage === 'submitted' ? /^(?:保存提交|提交|提交运行)$/ : /^自测运行$/;
    const fresh = rows.filter((row) => targetType.test(row.type));
    if (fresh.length > 1) return fail('出现多个新运行记录，无法确认结果归属。');
    const row = fresh[0];
    if (row && t.runId && row.id !== t.runId) return fail('运行记录已变化。');
    if (row) t.runId = row.id;
    if (!row || /等待|排队|运行中|编译中|判题中|评测中/.test(row.result)) {
      if (now() - t.started! > 60_000)
        return fail('等待新运行结果超时，不重复运行或提交。');
      return {
        state: 'running',
        message: t.stage === 'submitted' ? '等待本题判题…' : '等待自测结果…',
      };
    }
    if (
      /^100(?:\.0+)?%?$/.test(row.rate) &&
      /通过|成功|正确|Accepted/i.test(row.result)
    ) {
      const submitted = t.stage === 'submitted';
      t.stage = submitted ? 'accepted' : 'passed';
      return {
        state: submitted ? 'accepted' : 'passed',
        message: submitted
          ? '本题提交通过，全部用例通过。'
          : '自测通过，准备提交本题。',
      };
    }
    t.stage = 'failed';
    return {
      state: 'failed',
      message: `运行未通过：${row.result}（用例通过率 ${row.rate || '未知'}）。代码已保留。`,
    };
  };
}
