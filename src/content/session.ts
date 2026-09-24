import { isAcm } from '../core/programming';
import { classificationOf } from '../core/classification';
import { inferenceIssue, type Question, type Suggestion } from '../core/schema';
import { AppError } from '../core/errors';
import type { RunReport, ReportRecord } from '../core/report';

export type Phase =
  | 'paused'
  | 'watching'
  | 'thinking'
  | 'answering'
  | 'ready'
  | 'review'
  | 'error'
  | 'done';
export interface SessionState {
  phase: Phase;
  message: string;
  running: boolean;
  autoAnswer: boolean;
  completed: number;
  skipped: number;
  skippedHistory: Array<ReportRecord & { sequence: number }>;
  historyDropped: number;
  question?: Question;
  suggestion?: Suggestion;
}
export interface SessionDependencies {
  applyProgramming?(
    question: Question,
    suggestion: Suggestion,
    signal: AbortSignal,
    progress: (message: string) => void,
  ): Promise<'advanced' | 'section-end'>;
  capabilities?(question: Question): { answer: boolean; advance: boolean };
  suggest(question: Question, signal: AbortSignal): Promise<Suggestion>;
  apply(
    question: Question,
    suggestion: Suggestion,
    signal: AbortSignal,
    reviewed: boolean,
  ): Promise<'advanced' | 'section-end'>;
  skip(
    question: Question,
    signal: AbortSignal,
  ): Promise<'advanced' | 'section-end'>;
  nextSection?(
    question: Question,
    signal: AbortSignal,
  ): Promise<'advanced' | 'waiting'>;
  cancel(): Promise<unknown>;
  emit(state: SessionState): void;
  now?: () => number;
  settleMs?: number;
}

/** Lives in the page, independent of side-panel lifetime and SPA hash navigation. */
export class AutomaticSession {
  private enabled = false;
  private autoAnswer = true;
  private current: Question | null = null;
  private since = 0;
  private epoch = 0;
  private job: {
    abort: AbortController;
    promise: Promise<void>;
    applying: boolean;
  } | null = null;
  private cancellation: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<string, Suggestion>();
  private handled = new Set<string>();
  private pending: { question: Question; suggestion: Suggestion } | null = null;
  private completed = 0;
  private skipped = 0;
  private waitingMessage = '';
  private sectionId: string | undefined;
  private sectionOverflow = false;
  private sectionRecords = new Map<
    string,
    { index: number; record: ReportRecord }
  >();
  private retries = new Map<string, { attempts: number; after: number }>();
  private startedAt: number | null = null;
  private endedAt: number | null = null;
  private reachedEnd = false;
  private dropped = 0;
  private readonly records = new Map<string, ReportRecord>();
  constructor(private readonly deps: SessionDependencies) {}
  private emit(
    phase: Phase,
    message: string,
    result?: { question: Question; suggestion: Suggestion },
  ) {
    this.deps.emit({
      phase,
      message,
      running: this.enabled,
      autoAnswer: this.autoAnswer,
      completed: this.completed,
      skipped: this.skipped,
      skippedHistory: structuredClone(
        [...this.records.values()]
          .map((record, index) => ({
            ...record,
            sequence: this.dropped + index + 1,
          }))
          .filter((record) => record.status === 'skipped'),
      ),
      historyDropped: this.dropped,
      ...(result ?? (this.current ? { question: this.current } : {})),
    });
  }
  private abort() {
    this.epoch++;
    if (this.job) {
      this.job.abort.abort();
      this.cancellation = this.cancellation
        .then(() => this.deps.cancel())
        .catch(() => undefined);
    }
  }
  start(autoAnswer = true) {
    if (this.startedAt === null || this.endedAt !== null) {
      this.startedAt = (this.deps.now ?? Date.now)();
      this.endedAt = null;
      this.reachedEnd = false;
      this.records.clear();
      this.dropped = 0;
      this.completed = 0;
      this.skipped = 0;
      this.cache.clear();
      this.sectionRecords.clear();
      this.sectionOverflow = false;
      this.sectionId = undefined;
      this.retries.clear();
    }
    this.abort();
    this.enabled = true;
    this.autoAnswer = autoAnswer;
    this.handled.clear();
    this.pending = null;
    this.since = (this.deps.now ?? Date.now)();
    this.emit(
      'watching',
      autoAnswer
        ? '已开启自动解析、选答和下一题。'
        : '已开启自动解析，切题后自动更新。',
    );
  }
  stop(message = '已暂停。点击继续可恢复。', clear = false) {
    this.enabled = false;
    this.abort();
    this.pending = null;
    if (clear) {
      this.cache.clear();
      this.handled.clear();
    }
    this.emit('paused', message);
  }
  observe(question: Question | null, waitingMessage = '等待当前题目加载…') {
    if (this.job?.applying) return;
    if (
      this.enabled &&
      !question &&
      !this.job &&
      waitingMessage !== this.waitingMessage
    ) {
      this.waitingMessage = waitingMessage;
      this.emit('watching', waitingMessage);
    }
    if (question?.id !== this.current?.id) {
      if (
        question &&
        (this.reachedEnd || question.section?.id !== this.sectionId)
      ) {
        this.sectionRecords.clear();
        this.sectionOverflow = false;
        this.sectionId = question.section?.id;
      }
      // A manually opened new section can continue the same report/session.
      if (question && this.endedAt === null) this.reachedEnd = false;
      this.abort();
      this.current = question;
      this.pending = null;
      this.since = (this.deps.now ?? Date.now)();
      if (this.enabled)
        this.emit(
          'watching',
          question ? '发现新题，等待页面稳定…' : waitingMessage,
        );
      const cached = question ? this.cache.get(question.id) : undefined;
      if (this.enabled && question && cached && this.handled.has(question.id))
        this.emit('ready', '此题已解析，复用已有结果。', {
          question,
          suggestion: cached,
        });
      else if (
        this.enabled &&
        question &&
        this.handled.has(question.id) &&
        inferenceIssue(question)
      )
        this.emit('ready', `此题已跳过：${inferenceIssue(question)}`);
    }
    if (question && this.enabled && !this.job) {
      const retry = this.retries.get(question.id);
      if (retry && retry.after <= (this.deps.now ?? Date.now)()) {
        retry.after = Infinity;
        this.handled.delete(question.id);
      }
    }
    if (!this.enabled || !question || this.job || this.handled.has(question.id))
      return;
    if (
      (this.deps.now ?? Date.now)() - this.since <
      (this.deps.settleMs ?? 600)
    )
      return;
    if (question.isExample) this.advanceExample(question);
    else this.launch(question, false);
  }
  private advanceExample(question: Question) {
    this.handled.add(question.id);
    const epoch = this.epoch;
    const abort = new AbortController();
    const job = { abort, applying: true, promise: Promise.resolve() };
    this.job = job;
    const current = () =>
      this.enabled &&
      !abort.signal.aborted &&
      epoch === this.epoch &&
      this.current?.id === question.id;
    job.promise = (async () => {
      try {
        await this.cancellation;
        if (!current()) return;
        this.emit(
          'ready',
          '这是输入输出例题，不计分、不调用模型，也不计入已答或跳过。',
        );
        if (!this.autoAnswer || !this.deps.capabilities?.(question).advance)
          return;
        const outcome = await this.deps.skip(question, abort.signal);
        if (current())
          this.emit(
            'watching',
            outcome === 'advanced'
              ? '已略过输入输出例题，继续识别正式题。'
              : '例题已识别，等待进入正式题。',
          );
      } catch {
        if (current())
          this.emit('watching', '例题已识别，当前无法自动翻页；仍在识别。');
      } finally {
        if (this.job === job) this.job = null;
      }
    })();
  }
  confirm() {
    if (
      !this.enabled ||
      this.job ||
      !this.pending ||
      this.pending.question.id !== this.current?.id
    )
      return;
    this.launch(this.pending.question, true);
  }
  private launch(question: Question, reviewed: boolean) {
    const began = (this.deps.now ?? Date.now)();
    const previous = this.records.get(question.id);
    if (previous?.status === 'answered') this.completed--;
    if (previous?.status === 'skipped') this.skipped--;
    const record: ReportRecord = {
      questionId: question.id,
      type: question.typeLabel ?? question.kind,
      classification: classificationOf(question),
      stem: question.stem.slice(0, 5000),
      status: 'pending',
      selectedLabels: [],
      confidence: null,
      durationMs: 0,
    };
    if (!this.records.has(question.id) && this.records.size >= 300) {
      this.records.delete(this.records.keys().next().value!);
      this.dropped++;
    }
    this.records.set(question.id, record);
    if (question.section) {
      if (
        !this.sectionRecords.has(question.id) &&
        this.sectionRecords.size >= 1000
      )
        this.sectionOverflow = true;
      else
        this.sectionRecords.set(question.id, {
          index: question.section.index,
          record,
        });
    }
    const epoch = this.epoch,
      abort = new AbortController();
    const job = { abort, applying: false, promise: Promise.resolve() };
    this.job = job;
    const current = () =>
      this.enabled &&
      !abort.signal.aborted &&
      epoch === this.epoch &&
      this.current?.id === question.id;
    const finishSection = async (result?: {
      question: Question;
      suggestion: Suggestion;
    }) => {
      this.reachedEnd = true;
      const entries = [...this.sectionRecords.values()];
      const count = question.section?.index ?? 0;
      const covered =
        !this.sectionOverflow &&
        count > 0 &&
        entries.length === count &&
        new Set(entries.map((entry) => entry.index)).size === count &&
        entries.every(
          (entry) =>
            entry.index >= 1 &&
            entry.index <= count &&
            entry.record.status === 'answered',
        );
      let message = covered
        ? '本题型已作答，等待下一题型；仍在识别。'
        : '本题型有跳过、未完成或未识别题目，不自动进入下一题型；仍在识别。';
      if (covered && this.deps.nextSection) {
        this.emit(
          'answering',
          '本题型没有跳过题，正在检查下一题型入口…',
          result,
        );
        try {
          const outcome = await this.deps.nextSection(question, abort.signal);
          if (!current()) return;
          message =
            outcome === 'advanced'
              ? '已进入下一题型，自动继续识别。'
              : '本题型已作答，未找到已适配的下一题型入口；仍在识别，手动切换后自动继续。';
        } catch (error) {
          if (!current()) return;
          message = `题型衔接暂未完成：${error instanceof Error ? error.message : '请检查页面'} 仍在识别。`;
        }
      }
      if (current()) this.emit('done', message, result);
    };
    let canAdvance = false;
    job.promise = (async () => {
      try {
        await this.cancellation;
        if (!current()) return;
        const capabilities = this.deps.capabilities?.(question) ?? {
          answer: true,
          advance: true,
        };
        canAdvance = capabilities.advance;
        const unsupported = inferenceIssue(question);
        if (unsupported) {
          this.handled.add(question.id);
          record.reason = unsupported;
          if (!this.autoAnswer || !capabilities.advance) {
            record.status = 'skipped';
            this.skipped++;
            this.emit('ready', unsupported);
            return;
          }
          job.applying = true;
          this.emit('answering', `${unsupported} 正在跳过，不请求模型。`);
          const outcome = await this.deps.skip(question, abort.signal);
          if (!current()) return;
          this.skipped++;
          record.status = 'skipped';
          if (outcome === 'section-end') {
            await finishSection();
          } else this.emit('watching', `${unsupported} 已跳过，自动继续…`);
          return;
        }
        let suggestion = isAcm(question)
          ? undefined
          : this.cache.get(question.id);
        if (!suggestion) {
          this.emit('thinking', '正在解析当前题目…');
          suggestion = await this.deps.suggest(question, abort.signal);
          if (!current()) return;
          if (suggestion.questionId !== question.id)
            throw new Error('返回结果不属于当前题目，已暂停。');
          if (this.cache.size >= 100)
            this.cache.delete(this.cache.keys().next().value!);
          if (!isAcm(question)) this.cache.set(question.id, suggestion);
        }
        const result = { question, suggestion };
        record.selectedLabels = question.options
          .filter((o) => suggestion.selectedIds.includes(o.id))
          .map((o) => o.label);
        record.confidence = suggestion.confidence;
        record.notices = suggestion.notices
          .slice(0, 20)
          .map((notice) => notice.slice(0, 4000));
        if (suggestion.route) record.route = suggestion.route;
        if (suggestion.answerText) record.answerText = suggestion.answerText;
        this.handled.add(question.id);
        const skip =
          (suggestion.lowConfidence ??
            (question.kind === 'single' &&
              suggestion.needsReview &&
              suggestion.confidence !== null)) &&
          !reviewed;
        if (!this.autoAnswer || (!capabilities.answer && !skip)) {
          record.status = 'reference';
          record.reason = '解析完成，等待手动作答或切题。';
          this.emit('ready', record.reason, result);
          return;
        }
        if (suggestion.manualOnly && !skip) {
          record.status = 'reference';
          record.reason = '已生成参考答案，页面填写需手动完成。';
          this.emit(
            'ready',
            '参考答案已生成并记录。请手动填写；切题后自动继续。',
            result,
          );
          return;
        }
        if (suggestion.needsReview && !reviewed && !skip) {
          this.pending = result;
          this.emit(
            'review',
            '本题需要复核，请在网页中手动作答；切题后自动继续。',
            result,
          );
          return;
        }
        this.pending = null;
        if (skip && !capabilities.advance) {
          this.skipped++;
          record.status = 'skipped';
          record.reason = '确定度不足，此平台未适配翻页，请手动切题。';
          this.emit('ready', record.reason, result);
          return;
        }
        job.applying = true;
        this.emit(
          'answering',
          skip
            ? '置信度不足，不选答案，跳过本题…'
            : isAcm(question)
              ? '正在填写代码并验证运行结果…'
              : '正在选中答案并进入下一题…',
          result,
        );
        const outcome = skip
          ? await this.deps.skip(question, abort.signal)
          : isAcm(question) && this.deps.applyProgramming
            ? await this.deps.applyProgramming(
                question,
                suggestion,
                abort.signal,
                (message) => {
                  if (current()) this.emit('answering', message, result);
                },
              )
            : await this.deps.apply(
                question,
                suggestion,
                abort.signal,
                reviewed,
              );
        if (!current()) return;
        if (skip) this.skipped++;
        else this.completed++;
        record.status = skip ? 'skipped' : 'answered';
        record.reason = skip
          ? '最终模型的确定度仍不足，未选择答案。'
          : isAcm(question)
            ? '代码已回填，自测和单题提交均通过。'
            : '已验证页面选中状态。';
        if (outcome === 'section-end') {
          await finishSection(result);
        } else this.emit('watching', '已进入下一题，自动继续…', result);
      } catch (error) {
        if (current()) {
          if (
            error instanceof AppError &&
            error.code === 'UNSUPPORTED' &&
            this.autoAnswer &&
            canAdvance
          ) {
            try {
              job.applying = true;
              record.reason = error.message;
              const outcome = await this.deps.skip(question, abort.signal);
              if (!current()) return;
              this.handled.add(question.id);
              this.skipped++;
              record.status = 'skipped';
              if (outcome === 'section-end') {
                await finishSection();
              } else
                this.emit('watching', `${error.message} 已跳过，继续下一题。`);
              return;
            } catch (skipError) {
              error = skipError;
            }
          }
          record.status = 'failed';
          record.reason = error instanceof Error ? error.message : '处理失败';
          this.handled.add(question.id);
          const attempts = (this.retries.get(question.id)?.attempts ?? 0) + 1;
          const retryable =
            !job.applying &&
            error instanceof AppError &&
            ['NETWORK', 'TIMEOUT', 'PAGE_UNSTABLE'].includes(error.code) &&
            attempts <= 3;
          if (
            retryable &&
            !this.retries.has(question.id) &&
            this.retries.size >= 100
          )
            this.retries.delete(this.retries.keys().next().value!);
          if (retryable)
            this.retries.set(question.id, {
              attempts,
              after: (this.deps.now ?? Date.now)() + 5000 * 3 ** (attempts - 1),
            });
          this.emit(
            'error',
            `${record.reason} ${retryable ? '稍后自动重试，仍在识别。' : '本题暂不重复请求，切题后自动继续识别。'}`,
          );
        }
      } finally {
        record.durationMs = Math.max(0, (this.deps.now ?? Date.now)() - began);
        if (this.job === job) this.job = null;
      }
    })();
  }
  controlState() {
    return {
      started: this.startedAt !== null,
      running: this.enabled,
      ended: this.endedAt !== null,
      atEnd: this.reachedEnd,
    };
  }
  end(): RunReport {
    this.stop('本轮已结束，报告已生成。');
    this.endedAt ??= (this.deps.now ?? Date.now)();
    return {
      startedAt: new Date(this.startedAt ?? this.endedAt).toISOString(),
      endedAt: new Date(this.endedAt).toISOString(),
      reachedEnd: this.reachedEnd,
      dropped: this.dropped,
      records: structuredClone([...this.records.values()]),
    };
  }
  async settled() {
    await this.job?.promise;
  }
}
