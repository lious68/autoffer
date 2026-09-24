import { AppError } from '../core/errors';
import { CodeResultSchema, isAcm } from '../core/programming';
import type { Question, Suggestion } from '../core/schema';
import type { Request } from '../core/protocol';

type CodeRequest = Extract<Request, { type: 'code:command' }>;
export function createCodeRunner(
  request: (command: CodeRequest) => Promise<unknown>,
  assertCurrent: (question: Question) => unknown,
  advance: (
    question: Question,
    signal: AbortSignal,
  ) => Promise<'advanced' | 'section-end'>,
  waitMs = 700,
) {
  return async (
    question: Question,
    suggestion: Suggestion,
    signal: AbortSignal,
    progress: (message: string) => void,
  ) => {
    if (
      !isAcm(question) ||
      !suggestion.editor ||
      !suggestion.answerText ||
      suggestion.manualOnly ||
      suggestion.needsReview
    )
      throw new AppError('CODE_ACTION', '没有可自动填写的代码答案。');
    const token = suggestion.editor.token;
    const check = () => {
      if (signal.aborted) throw new AppError('CANCELLED', '已停止代码作答。');
      assertCurrent(question);
    };
    const send = async (action: CodeRequest['action'], code?: string) => {
      check();
      const raw = await request({
        type: 'code:command',
        tabId: 0,
        token,
        action,
        ...(code ? { code } : {}),
      });
      check();
      const result = CodeResultSchema.parse(raw);
      if (result.state === 'failed')
        throw new AppError('CODE_RUN', result.message);
      return result;
    };
    const pause = () =>
      new Promise<void>((resolve, reject) => {
        const cleanup = () => signal.removeEventListener('abort', stopped);
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, waitMs);
        const stopped = () => {
          clearTimeout(timer);
          cleanup();
          reject(new AppError('CANCELLED', '已停止代码作答。'));
        };
        signal.addEventListener('abort', stopped, { once: true });
        if (signal.aborted) stopped();
      });
    const wait = async (expected: 'passed' | 'accepted') => {
      // Bound independently of page-provided state and avoid busy retrying a runner.
      const deadline = Date.now() + 65_000;
      while (Date.now() < deadline) {
        await pause();
        const result = await send('poll');
        if (result.state === expected) {
          progress(result.message);
          return;
        }
        if (result.state !== 'running')
          throw new AppError('CODE_RUN', '代码运行返回了意外状态。');
      }
      throw new AppError('CODE_RUN', '等待判题超时，保留代码，不重复提交。');
    };
    const cancel = () => {
      void request({
        type: 'code:command',
        tabId: 0,
        token,
        action: 'cancel',
      }).catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      progress(`正在填写 ${suggestion.editor.language} 代码…`);
      const filled = await send('fill', suggestion.answerText);
      if (filled.state !== 'filled')
        throw new AppError('CODE_ACTION', '未确认代码回填成功。');
      progress('代码已回填，正在自测…');
      await send('run');
      await wait('passed');
      progress('自测通过，正在保存提交本题…');
      await send('submit');
      await wait('accepted');
      check();
      return await advance(question, signal);
    } finally {
      signal.removeEventListener('abort', cancel);
      cancel();
    }
  };
}
