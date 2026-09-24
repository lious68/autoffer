import { AppError } from '../core/errors';
import {
  inferenceIssue,
  semanticQuestion,
  type Question,
  type Suggestion,
} from '../core/schema';
import { matchPlatform, platforms, scanPage } from './registry';
import type { PlatformAdapter, PlatformContext } from './types';

/** The only interaction entry point used by the content UI. Re-resolve on every action. */
export function createPlatformRuntime(
  context: PlatformContext,
  adapters = platforms,
) {
  function fail(message: string): never {
    throw new AppError('ACTION_PAUSED', message);
  }
  function current(expected: Question) {
    const scan = scanPage(context, adapters);
    if (scan.questions.length !== 1 || !scan.questions[0])
      fail(scan.warnings[0] ?? '未找到唯一题目，已暂停。');
    if (
      JSON.stringify(semanticQuestion(scan.questions[0]!)) !==
      JSON.stringify(semanticQuestion(expected))
    )
      fail('题目已经变化，旧答案不会写入。');
    return matchPlatform(context, adapters)!;
  }
  function capabilitiesFor(question: Question, adapter: PlatformAdapter) {
    const actions = adapter.actions;
    return {
      answer: Boolean(
        actions?.apply &&
        actions.answerKinds.some((kind) => kind === question.kind) &&
        !inferenceIssue(question),
      ),
      advance: Boolean(actions?.skip),
    };
  }
  return {
    navigation() {
      return matchPlatform(context, adapters)?.navigation?.list(context) ?? [];
    },
    selectQuestion(id: string) {
      const navigation = matchPlatform(context, adapters)?.navigation;
      if (!navigation) fail('此平台不支持页内切题。');
      navigation.select(context, id);
    },
    async nextSection(question: Question, signal: AbortSignal) {
      if (signal.aborted) fail('操作已停止。');
      const adapter = current(question);
      if (!adapter.actions?.nextSection) return 'waiting' as const;
      adapter.actions.assertReady(context, question);
      return adapter.actions.nextSection(context, question, signal);
    },
    capabilities: (question: Question) =>
      capabilitiesFor(question, current(question)),
    assertCurrent: current,
    async apply(
      question: Question,
      suggestion: Suggestion,
      signal: AbortSignal,
      reviewed = false,
    ) {
      if (signal.aborted) fail('操作已停止。');
      const adapter = current(question);
      if (!capabilitiesFor(question, adapter).answer)
        fail('此平台尚未适配本题选答，请手动作答。');
      if (
        suggestion.questionId !== question.id ||
        suggestion.manualOnly ||
        (suggestion.needsReview && !reviewed)
      )
        fail('这份建议需要手动处理或确认后才能选答。');
      const ids = suggestion.selectedIds;
      if (
        !ids.length ||
        new Set(ids).size !== ids.length ||
        ids.some(
          (id) => !question.options.some((option) => option.id === id),
        ) ||
        (question.kind === 'single' && ids.length !== 1)
      )
        fail('答案选项无效，已暂停。');
      adapter.actions!.assertReady(context, question);
      return adapter.actions!.apply!(
        context,
        question,
        suggestion,
        signal,
        reviewed,
      );
    },
    async skip(question: Question, signal: AbortSignal) {
      if (signal.aborted) fail('操作已停止。');
      const adapter = current(question);
      if (!adapter.actions?.skip) fail('此平台尚未适配翻页，请手动切题。');
      adapter.actions.assertReady(context, question);
      return adapter.actions.skip(context, question, signal);
    },
  };
}
