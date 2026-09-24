import { AppError } from '../../core/errors';
import {
  inferenceIssue,
  semanticQuestion,
  type Question,
  type Suggestion,
} from '../../core/schema';
import { visible } from '../template';
import type { PlatformContext } from '../types';
import { currentEntry, cursorAttribute, entries } from './extractor';

function fail(message: string): never {
  throw new AppError('ACTION_PAUSED', message);
}
export function assertReady(context: PlatformContext, expected: Question) {
  if (
    [
      ...context.document.querySelectorAll(
        '[role="dialog"], [aria-modal="true"], .layui-layer-shade',
      ),
    ].some(visible)
  )
    fail('页面有弹窗，请先处理后再继续。');
  const entry = currentEntry(context);
  if (
    !entry ||
    JSON.stringify(semanticQuestion(entry.question)) !==
      JSON.stringify(semanticQuestion(expected))
  )
    fail('题目已经变化，旧答案不会写入。');
  return entry;
}
export function select(context: PlatformContext, id: string) {
  const entry = entries(context).find((item) => item.question.id === id);
  if (!entry) fail('题目已隐藏或变化，请重新选择。');
  context.document
    .querySelector('form#form1')!
    .setAttribute(cursorAttribute, entry.topic);
  entry.block.scrollIntoView?.({ block: 'center', behavior: 'instant' });
}
export async function skip(
  context: PlatformContext,
  question: Question,
  signal: AbortSignal,
): Promise<'advanced' | 'section-end'> {
  if (signal.aborted) fail('操作已停止。');
  assertReady(context, question);
  const all = entries(context);
  const index = all.findIndex((entry) => entry.question.id === question.id);
  const next = all[index + 1];
  if (index < 0) fail('当前题目已变化。');
  // Navigation is a local cursor only. Never click ctlNext (the form submit control).
  if (!next) return 'section-end';
  select(context, next.question.id);
  return 'advanced';
}
function inputFor(row: HTMLElement) {
  const inputs = row.querySelectorAll<HTMLInputElement>(
    'input[type="radio"], input[type="checkbox"]',
  );
  if (inputs.length !== 1) fail('选项控件不唯一，已暂停。');
  return inputs[0]!;
}
function selected(row: HTMLElement) {
  const checked = inputFor(row).checked;
  const marker = row.querySelector('.jqradio, .jqcheck');
  if (marker && marker.classList.contains('jqchecked') !== checked)
    fail('选项显示与表单状态不一致，已暂停。');
  return checked;
}
export async function apply(
  context: PlatformContext,
  question: Question,
  suggestion: Suggestion,
  signal: AbortSignal,
  reviewed: boolean,
): Promise<'advanced' | 'section-end'> {
  const check = () => {
    if (signal.aborted) fail('操作已停止。');
    return assertReady(context, question);
  };
  const entry = check();
  const issue = inferenceIssue(question);
  if (issue) fail(issue);
  if (
    !['single', 'multiple'].includes(question.kind) ||
    suggestion.questionId !== question.id ||
    suggestion.manualOnly ||
    (suggestion.needsReview && !reviewed)
  )
    fail('本题需要手动处理。');
  const ids = suggestion.selectedIds;
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !question.options.some((o) => o.id === id)) ||
    (question.kind === 'single' && ids.length !== 1)
  )
    fail('答案选项无效。');
  const rows = [
    ...entry.block.querySelectorAll<HTMLElement>(
      '.ui-controlgroup > .ui-radio, .ui-controlgroup > .ui-checkbox',
    ),
  ].filter(visible);
  if (rows.length !== question.options.length) fail('选项布局已经变化。');
  const desired = rows.map((_, i) => ids.includes(question.options[i]!.id));
  for (const row of rows) {
    const input = inputFor(row);
    if (
      input.disabled ||
      row.getAttribute('aria-disabled') === 'true' ||
      input.closest('fieldset[disabled]') ||
      input.type !== (question.kind === 'single' ? 'radio' : 'checkbox')
    )
      fail('选项不可操作或类型不匹配。');
  }
  for (let i = 0; i < rows.length; i++) {
    check();
    const row = rows[i]!;
    if (
      selected(row) === desired[i] ||
      (question.kind === 'single' && !desired[i])
    )
      continue;
    const labels = row.querySelectorAll<HTMLElement>('.label');
    if (labels.length !== 1) fail('选项标签不唯一。');
    const label = labels[0]!;
    if (label.getAttribute('for') !== inputFor(row).id)
      fail('选项标签与输入框不对应。');
    label.scrollIntoView?.({ block: 'center', behavior: 'instant' });
    const rect = label.getBoundingClientRect();
    const hit = context.document.elementFromPoint?.(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    if (
      !row.isConnected ||
      !visible(label) ||
      !rect.width ||
      !rect.height ||
      !hit ||
      !(hit === label || label.contains(hit))
    )
      fail('选项被遮挡或不可见，已暂停。');
    check();
    label.click();
    // Let the host handler finish, then verify both the form and visible marker.
    await new Promise((resolve) => setTimeout(resolve, 80));
    check();
    if (!row.isConnected || selected(row) !== desired[i])
      fail('未确认选项已选中，停止切题。');
  }
  check();
  if (rows.some((row, i) => !row.isConnected || selected(row) !== desired[i]))
    fail('实际选中结果与建议不一致。');
  return skip(context, question, signal);
}
