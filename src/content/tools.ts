import { createCodeRunner } from './code-runner';
import { isAcm } from '../core/programming';
import { brandIcon } from '../ui/brand';
import { toolsStyle } from './tools-style';
import {
  SnapshotSchema,
  SuggestionSchema,
  inferenceIssue,
} from '../core/schema';
import { scanPage } from '../platforms/registry';
import { createPlatformRuntime } from '../platforms/runtime';
import type { Request, Reply } from '../core/protocol';
import { AutomaticSession, type SessionState } from './session';
import { AppError } from '../core/errors';
import { reportSummary } from '../core/report';

type PageRequest = Extract<
  Request,
  { type: 'scan' | 'suggest' | 'cancel' | 'report:save' | 'code:command' }
>;

export function mountTools(document: Document, url: URL) {
  if (!['https:', 'http:'].includes(url.protocol))
    throw new Error('请在普通网页启用悬浮球。');
  const context = {
    document,
    get url() {
      return new URL(document.URL);
    },
  };
  const host = document.createElement('div');
  host.id = 'autoffer-page-tools';
  // Extension reloads may leave an orphaned widget from the old isolated context.
  document.getElementById(host.id)?.remove();
  host.style.cssText =
    'position:fixed!important;inset:auto 20px 32px auto!important;z-index:2147483647!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;';
  host.setAttribute('popover', 'manual');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = toolsStyle;
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = '',
    cls = '',
  ) => {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = cls;
    return node;
  };
  const wrap = el('div', '', 'wrap'),
    panel = el('section', '', 'panel');
  panel.setAttribute('aria-label', 'AutOffer 自动答题');
  panel.hidden = true;
  const heading = el('header'),
    title = el('strong', 'AutOffer'),
    fold = el('button', '−', 'close');
  fold.title = '收起';
  const phase = el('span', '未启动', 'phase');
  fold.setAttribute('aria-label', '收起面板');
  heading.append(brandIcon(document, 'widget-logo'), title, phase, fold);
  const mode = el('p', '自动识别当前题目', 'mode muted'),
    status = el('p', '尚未启动', 'message');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const log = el('ol', '', 'activity-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', '运行日志');
  log.setAttribute('aria-live', 'polite');
  let lastLog = '';
  const panelBody = el('div', '', 'panel-body');
  const navigation = el('div', '', 'question-navigation');
  navigation.hidden = true;
  const questionSelect = el('select');
  questionSelect.setAttribute('aria-label', '选择题目');
  const nextQuestion = el('button', '下一题', 'control');
  nextQuestion.type = 'button';
  navigation.append(questionSelect, nextQuestion);
  const reference = el('div');
  reference.hidden = true;
  const referenceStem = el('p', '', 'stem');
  const referenceAnswer = el('p', '', 'reference-answer');
  const referenceDetails = el('p', '', 'details');
  reference.append(referenceStem, referenceAnswer, referenceDetails);
  panelBody.append(mode, navigation, status, reference, log);
  panel.append(heading, panelBody);
  const ball = el('button', '', 'ball paused'),
    dot = el('span', '', 'dot');
  ball.append(brandIcon(document, 'ball-logo'), dot);
  ball.title = 'AutOffer · 点击展开，拖动移动';
  ball.setAttribute('aria-label', 'AutOffer 悬浮球');
  ball.setAttribute('aria-expanded', 'false');
  wrap.append(panel, ball);
  shadow.append(style, wrap);
  let disposed = false,
    hidden = false,
    dragged = false;
  const initialState: SessionState = {
    phase: 'paused',
    message: '尚未启动',
    running: false,
    autoAnswer: true,
    completed: 0,
    skipped: 0,
    skippedHistory: [],
    historyDropped: 0,
  };
  const request = async (message: PageRequest) => {
    const reply = (await chrome.runtime.sendMessage(message)) as Reply;
    if (!reply?.ok)
      throw new AppError(
        reply && !reply.ok ? reply.error.code : 'CONNECTION',
        reply && !reply.ok
          ? reply.error.message
          : '扩展连接失效，请从工具栏重新启用。',
      );
    return reply.data;
  };
  function render(value: SessionState) {
    questionSelect.disabled = value.phase === 'answering';
    nextQuestion.disabled = value.phase === 'answering';
    reference.hidden = !value.suggestion;
    referenceStem.textContent = value.suggestion
      ? (value.question?.stem ?? '')
      : '';
    referenceAnswer.textContent = value.suggestion
      ? (value.suggestion.answerText ??
        value.question?.options
          .filter((o) => value.suggestion!.selectedIds.includes(o.id))
          .map((o) => `${o.label} · ${o.text}`)
          .join('\n') ??
        '')
      : '';
    referenceDetails.textContent = value.suggestion?.notices.join('\n') ?? '';
    host.setAttribute('data-running', String(value.running));
    const phases = {
      paused: '已暂停',
      watching: '等待题目',
      thinking: '解析中',
      answering: '作答中',
      ready: '已解析',
      review: '待复核',
      error: '需处理',
      done: '本题型结束',
    };
    phase.textContent = phases[value.phase];
    const busy = ['thinking', 'answering'].includes(value.phase);
    ball.className = `ball ${value.phase} ${busy ? 'busy' : ''}`;
    ball.setAttribute('aria-busy', String(busy));
    ball.title = value.message;
    status.textContent = value.message;
    mode.textContent = `${value.autoAnswer ? '自动解析并作答' : '自动解析 · 手动作答'} · 已答 ${value.completed} · 跳过 ${value.skipped}`;
    const identity = `${value.phase}/${value.question?.id ?? ''}/${value.message}`;
    if (identity !== lastLog) {
      lastLog = identity;
      const entry = el('li');
      entry.dataset.phase = value.phase;
      const time = el(
        'time',
        new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        'log-time',
      );
      entry.append(time, document.createTextNode(value.message));
      log.append(entry);
      if (log.children.length > 60) log.firstElementChild!.remove();
      log.scrollTop = log.scrollHeight;
    }
    if (
      (['review', 'error', 'done'].includes(value.phase) ||
        (value.phase === 'ready' && value.suggestion)) &&
      !hidden
    ) {
      panel.hidden = false;
      ball.setAttribute('aria-expanded', 'true');
    }
  }
  const platform = createPlatformRuntime(context);
  const session = new AutomaticSession({
    capabilities: (question) => ({
      ...platform.capabilities(question),
      ...(isAcm(question) ? { answer: true } : {}),
    }),
    applyProgramming: createCodeRunner(
      request,
      platform.assertCurrent,
      platform.skip,
    ),
    emit: render,
    cancel: () => request({ type: 'cancel', tabId: 0 }),
    async suggest(question, signal) {
      const reason = inferenceIssue(question);
      if (reason) throw new Error(reason);
      platform.assertCurrent(question);
      const snapshot = SnapshotSchema.parse(
        await request({ type: 'scan', tabId: 0 }),
      );
      if (signal.aborted) throw new Error('已停止。');
      if (
        snapshot.questions.length !== 1 ||
        snapshot.questions[0]?.id !== question.id
      )
        throw new AppError('PAGE_UNSTABLE', '页面尚未稳定，等待自动重试。');
      return SuggestionSchema.parse(
        await request({
          type: 'suggest',
          tabId: 0,
          scanId: snapshot.scanId,
          questionId: question.id,
        }),
      );
    },
    apply: platform.apply,
    skip: platform.skip,
    nextSection: platform.nextSection,
  });
  let navigationSignature = '';
  function refreshNavigation() {
    try {
      const items = platform.navigation();
      navigation.hidden = items.length < 2;
      const signature = JSON.stringify(items);
      if (signature !== navigationSignature) {
        questionSelect.replaceChildren(
          ...items.map((item) => {
            const option = el('option', item.label);
            option.value = item.id;
            return option;
          }),
        );
        navigationSignature = signature;
      }
    } catch {
      navigation.hidden = true;
    }
  }
  questionSelect.addEventListener('change', (event) => {
    if (!event.isTrusted || questionSelect.disabled) return;
    try {
      platform.selectQuestion(questionSelect.value);
      tick();
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : '切题失败。';
    }
  });
  nextQuestion.addEventListener('click', (event) => {
    if (!event.isTrusted || nextQuestion.disabled) return;
    const next = questionSelect.options[questionSelect.selectedIndex + 1];
    if (!next) {
      status.textContent = '已到本页最后一题，请核对答案后手动提交。';
      return;
    }
    try {
      platform.selectQuestion(next.value);
      tick();
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : '切题失败。';
    }
  });
  function tick() {
    if (disposed) return;
    const scan = scanPage(context);
    refreshNavigation();
    if (scan.questions[0]) questionSelect.value = scan.questions[0].id;
    session.observe(
      scan.questions.length === 1 ? scan.questions[0]! : null,
      scan.questions.length > 1
        ? '当前页有多个题目，自动模式需要唯一可见题目。'
        : (scan.warnings[0] ?? '等待题目加载…'),
    );
  }
  function isPopoverOpen() {
    return (
      typeof host.showPopover === 'function' && host.matches(':popover-open')
    );
  }
  function position() {
    const parent = document.fullscreenElement ?? document.body;
    if (host.parentElement !== parent) {
      if (isPopoverOpen()) host.hidePopover();
      parent.append(host);
    }
    if (!hidden && typeof host.showPopover === 'function' && !isPopoverOpen()) {
      try {
        host.showPopover();
      } catch {
        /* fixed stacking fallback */
      }
    }
  }
  const onTrusted = (node: HTMLElement, fn: () => void) =>
    node.addEventListener('click', (event) => {
      if (event.isTrusted) fn();
    });
  function end() {
    const report = session.end();
    phase.textContent = '本轮结束';
    const summary = reportSummary(report);
    status.textContent = `本轮结束 · 已答 ${summary.answered} · 跳过 ${summary.skipped} · 参考答案 ${summary.reference}`;
    return report;
  }
  onTrusted(ball, () => {
    if (dragged) {
      dragged = false;
      return;
    }
    panel.hidden = !panel.hidden;
    ball.setAttribute('aria-expanded', String(!panel.hidden));
  });
  onTrusted(fold, () => {
    panel.hidden = true;
    ball.setAttribute('aria-expanded', 'false');
  });
  let drag: { x: number; y: number; left: number; top: number } | null = null;
  ball.addEventListener('pointerdown', (event) => {
    if (!event.isTrusted || event.button !== 0) return;
    const rect = host.getBoundingClientRect();
    drag = {
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    dragged = false;
    ball.setPointerCapture(event.pointerId);
  });
  ball.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
    if (dragged) {
      const width = document.defaultView?.innerWidth ?? 1000,
        height = document.defaultView?.innerHeight ?? 800;
      host.style.setProperty(
        'inset',
        `${Math.max(10, Math.min(height - 80, drag.top + dy))}px auto auto ${Math.max(10, Math.min(width - 80, drag.left + dx))}px`,
        'important',
      );
    }
  });
  ball.addEventListener('pointerup', () => {
    drag = null;
  });
  ball.addEventListener('pointercancel', () => {
    drag = null;
  });
  // Polling covers SPA navigation and text changes inside open shadow roots.
  const timer = setInterval(tick, 700);
  const changed = () => {
    tick();
  };
  document.addEventListener('visibilitychange', changed);
  document.addEventListener('fullscreenchange', position);
  position();
  render(initialState);
  return {
    historyVersion: 6,
    getState() {
      return {
        ...session.controlState(),
        mounted: !disposed,
        hidden,
      };
    },
    start(autoAnswer = true) {
      log.replaceChildren();
      lastLog = '';
      session.start(autoAnswer);
      tick();
    },
    stop(clear = false) {
      session.stop('已暂停。', clear);
    },
    end,
    dispose() {
      disposed = true;
      session.stop();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', changed);
      document.removeEventListener('fullscreenchange', position);
      host.remove();
    },
    show() {
      if (disposed) return false;
      hidden = false;
      host.style.removeProperty('display');
      position();
      return true;
    },
  };
}
