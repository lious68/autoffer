import type { SessionState } from './session';

/** Local inspection only: opening history never requests a model or clicks the exam. */
export function createSkippedHistory(document: Document) {
  const root = document.createElement('details');
  root.className = 'skip-history';
  root.hidden = true;
  const title = document.createElement('summary');
  const list = document.createElement('div');
  list.className = 'skip-list';
  list.setAttribute('aria-label', '本轮跳过题目');
  const note = document.createElement('p');
  note.className = 'muted';
  root.append(title, note, list);
  let fingerprint = '';
  let previousPhase: SessionState['phase'] = 'paused';
  function update(state: SessionState) {
    const records = state.skippedHistory;
    root.hidden = records.length === 0 && state.historyDropped === 0;
    title.textContent = `跳过记录（${records.length}）`;
    note.textContent = state.historyDropped
      ? `以下为最近 300 题中的跳过记录；较早 ${state.historyDropped} 条题目记录已移除。`
      : '本轮序号按识别顺序排列。展开查看，不会重新调用模型。';
    if (state.phase === 'done' && previousPhase !== 'done' && records.length)
      root.open = true;
    previousPhase = state.phase;
    const next = JSON.stringify(records);
    if (next === fingerprint) return;
    fingerprint = next;
    const expanded = new Set(
      [...list.querySelectorAll('details[open]')].map(
        (node) => (node as HTMLElement).dataset.questionId,
      ),
    );
    const scrollTop = list.scrollTop;
    list.replaceChildren();
    for (const record of records) {
      const item = document.createElement('details');
      item.className = 'skip-item';
      item.dataset.questionId = record.questionId;
      item.open = expanded.has(record.questionId);
      const summary = document.createElement('summary');
      summary.textContent = `本轮第 ${record.sequence} 题 · ${record.type}\n${record.stem.slice(0, 72)}${record.stem.length > 72 ? '…' : ''}`;
      item.append(summary);
      const lines = [
        record.stem,
        record.selectedLabels.length
          ? `模型建议：${record.selectedLabels.join('、')}（未自动选答）`
          : '没有可用的选项建议。',
        ...(record.confidence === null
          ? []
          : [`模型确定度：${Math.round(record.confidence * 100)}%`]),
        `跳过原因：${record.reason ?? '未达到作答条件。'}`,
        ...(record.notices ?? []),
        ...(record.answerText ? [`参考答案：${record.answerText}`] : []),
        ...(record.route?.length
          ? [
              `模型路线：${record.route.map((route) => `${route.provider}/${route.model} [${route.outcome}]${route.reason ? ' ' + route.reason : ''}`).join(' → ')}`,
            ]
          : []),
      ];
      for (const line of lines) {
        const paragraph = document.createElement('p');
        paragraph.textContent = line;
        item.append(paragraph);
      }
      list.append(item);
    }
    list.scrollTop = scrollTop;
  }
  return { root, update };
}
