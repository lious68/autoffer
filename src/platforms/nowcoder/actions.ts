import { AppError } from '../../core/errors';
import {
  unsupportedReason,
  inferenceIssue,
  semanticQuestion,
  type Question,
  type Suggestion,
} from '../../core/schema';
import { visible } from '../template';
import type { PlatformContext } from '../types';
import nowcoder from './extractor';

function fail(message: string): never {
  throw new AppError('ACTION_PAUSED', message);
}

export function assertQuestionPage(
  context: PlatformContext,
  expected?: Question,
) {
  if (!nowcoder.matches(context)) fail('当前平台尚未适配自动选答。');
  const dialogs = context.document.querySelectorAll(
    '[role="dialog"], [aria-modal="true"], .el-message-box__wrapper',
  );
  if ([...dialogs].some(visible)) fail('页面有弹窗，请先处理后再继续。');
  const scan = nowcoder.extract(context);
  const question = scan.questions[0];
  if (scan.questions.length !== 1 || !question)
    fail('未找到唯一题目，已暂停。');
  if (
    expected &&
    JSON.stringify(semanticQuestion(question)) !==
      JSON.stringify(semanticQuestion(expected))
  )
    fail('题目已经变化，旧答案不会写入。');
  return question;
}

export function assertAnswerPage(
  context: PlatformContext,
  expected?: Question,
) {
  const question = assertQuestionPage(context, expected);
  const reason =
    question.kind === 'text'
      ? unsupportedReason(question)
      : inferenceIssue(question);
  if (reason) fail(reason);
  if (question.hasVisual && question.visuals?.some((v) => !v.ready))
    fail('题目图片尚未加载，暂不写入答案。');
  return question;
}

function selected(option: Element) {
  return (
    option.getAttribute('aria-checked') === 'true' ||
    // Verified on enterprise single and indefinite multiple choice; focus is not selection.
    option.classList.contains('selected') ||
    Boolean(option.querySelector('input:checked'))
  );
}

/** Only explicitly observed next-question buttons are actionable; submit is never a fallback. */
function nextButton(document: Document) {
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>('button'),
  ].filter(
    (button) => visible(button) && button.textContent?.trim() === '下一题',
  );
  if (
    buttons.length !== 1 ||
    buttons[0]!.disabled ||
    buttons[0]!.getAttribute('aria-disabled') === 'true'
  )
    return null;
  return buttons[0]!;
}

function clickVisible(node: HTMLElement, document: Document) {
  if (!node.isConnected || !visible(node)) fail('目标控件不可见，已暂停。');
  const rect = node.getBoundingClientRect();
  const hit = document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
  if (!hit || !(hit === node || node.contains(hit)))
    fail('目标控件被遮挡或不在可见区域，请调整页面后重试。');
  node.click();
}

export async function selectAndAdvance(
  context: PlatformContext,
  question: Question,
  suggestion: Suggestion,
  signal: AbortSignal,
  reviewed = false,
): Promise<'advanced' | 'section-end'> {
  const assertCurrent = () => {
    if (signal.aborted) fail('操作已停止。');
    assertAnswerPage(context, question);
  };
  assertCurrent();
  if (
    suggestion.questionId !== question.id ||
    (suggestion.needsReview && !reviewed)
  )
    fail('这份建议需要确认后才能选答。');
  const ids = suggestion.selectedIds;
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !question.options.some((o) => o.id === id)) ||
    (question.kind === 'single' && ids.length !== 1)
  )
    fail('答案选项无效，已暂停。');
  const nodes = [
    ...context.document.querySelectorAll<HTMLElement>(
      '.question-preview-container .answers > .option-item',
    ),
  ].filter(visible);
  if (nodes.length !== question.options.length)
    fail('选项布局已变化，已暂停。');
  const desired = nodes.map((_, i) => ids.includes(question.options[i]!.id));
  for (let i = 0; i < nodes.length; i++) {
    assertCurrent();
    const node = nodes[i]!;
    if (
      selected(node) === desired[i] ||
      (question.kind === 'single' && !desired[i])
    )
      continue;
    clickVisible(node, context.document);
    // Vue may update checked state on its next render. Never advance on a click alone.
    for (
      let attempt = 0;
      attempt < 20 && selected(node) !== desired[i];
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assertCurrent();
    }
    if (selected(node) !== desired[i])
      fail('未确认选项已选中，已暂停；此页面的选中状态可能尚未适配。');
  }
  assertCurrent();
  if (
    nodes.some((node, i) => !node.isConnected || selected(node) !== desired[i])
  )
    fail('选中结果与建议不一致，已暂停。');
  return advanceWithoutAnswer(context, question, signal);
}

/** Move past a low-confidence question without selecting or changing any option. */
export async function advanceWithoutAnswer(
  context: PlatformContext,
  question: Question,
  signal: AbortSignal,
): Promise<'advanced' | 'section-end'> {
  if (signal.aborted) fail('操作已停止。');
  assertQuestionPage(context, question);
  const next = nextButton(context.document);
  if (!next) return 'section-end';
  clickVisible(next, context.document);
  // A next click can fail or open a confirmation. Report success only after a new question.
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (signal.aborted) fail('操作已停止。');
    const current = assertQuestionPage(context);
    if (current.id !== question.id) return 'advanced';
  }
  return fail('已点击下一题，但题目尚未切换。请检查页面，不会重复点击。');
}

/** Only an explicit next-section control is eligible; unknown submit flows wait. */
export async function advanceSection(
  context: PlatformContext,
  question: Question,
  signal: AbortSignal,
): Promise<'advanced' | 'waiting'> {
  if (signal.aborted) fail('操作已停止。');
  assertQuestionPage(context, question);
  const next = [
    ...context.document.querySelectorAll<HTMLButtonElement>('button'),
  ].filter(
    (button) =>
      visible(button) &&
      ['下一题型', '进入下一题型'].includes(button.textContent?.trim() ?? ''),
  );
  if (
    next.length !== 1 ||
    next[0]!.disabled ||
    next[0]!.getAttribute('aria-disabled') === 'true'
  )
    return 'waiting';
  // Do not interpret 提交本题型, 交卷 or an unknown confirmation as navigation.
  clickVisible(next[0]!, context.document);
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (signal.aborted) fail('操作已停止。');
    const scan = nowcoder.extract(context);
    if (scan.questions.length === 1 && scan.questions[0]!.id !== question.id)
      return 'advanced';
  }
  return 'waiting';
}
