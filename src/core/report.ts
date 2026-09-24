import { ClassificationSchema } from './classification';
import { z } from 'zod';
import { SuggestionSchema } from './schema';

export const ReportRecordSchema = z.object({
  questionId: z.string().max(200),
  type: z.string().max(40),
  classification: ClassificationSchema.optional(),
  stem: z.string().max(5000),
  status: z.enum(['pending', 'answered', 'skipped', 'reference', 'failed']),
  selectedLabels: z.array(z.string().max(100)).max(50),
  answerText: z.string().max(20000).optional(),
  confidence: z.number().min(0).max(1).nullable(),
  durationMs: z.number().nonnegative(),
  route: SuggestionSchema.shape.route,
  reason: z.string().max(2000).optional(),
  notices: z.array(z.string().max(4000)).max(20).optional(),
});
export type ReportRecord = z.infer<typeof ReportRecordSchema>;
export const RunReportSchema = z.object({
  startedAt: z.string(),
  endedAt: z.string(),
  reachedEnd: z.boolean(),
  dropped: z.number().int().nonnegative(),
  records: z.array(ReportRecordSchema).max(300),
});
export type RunReport = z.infer<typeof RunReportSchema>;
export function reportSummary(report: RunReport) {
  return {
    total: report.records.length,
    answered: report.records.filter((r) => r.status === 'answered').length,
    skipped: report.records.filter((r) => r.status === 'skipped').length,
    reference: report.records.filter((r) => r.status === 'reference').length,
    failed: report.records.filter((r) => r.status === 'failed').length,
  };
}
function fenced(value: string) {
  const runs = value.match(/~+/g) ?? [];
  const fence = '~'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${fence}text\n${value}\n${fence}`;
}
export function formatReport(report: RunReport) {
  const s = reportSummary(report),
    labels = {
      pending: '未完成',
      answered: '已作答',
      skipped: '已跳过',
      reference: '参考答案 / 需手动填写',
      failed: '失败',
    };
  return [
    '# AutOffer 本轮报告',
    `开始：${report.startedAt}  \n结束：${report.endedAt}`,
    `记录 ${s.total} 题；已作答 ${s.answered}，跳过 ${s.skipped}，参考答案 ${s.reference}，失败 ${s.failed}。`,
    report.reachedEnd
      ? '已到达当前题型末题，未交卷。'
      : '手动结束，仅覆盖本轮识别过的题目。',
    '报告中的置信度不是实测正确率，报告不代表题目已提交或得到官方评分。',
    ...(report.dropped
      ? [`仅保留最近 300 题，较早 ${report.dropped} 条记录未包含。`]
      : []),
    ...report.records.flatMap((r, i) => [
      `## ${i + 1}. ${labels[r.status]}`,
      fenced(
        `题型：${r.type}${r.classification ? `\n分类：${r.classification.domain} / ${r.classification.format} / ${r.classification.intent}${r.classification.subject ? ` / ${r.classification.subject}` : ''}` : ''}\n题目：${r.stem}\n答案：${r.selectedLabels.join('、') || '—'}\n${r.answerText ?? ''}\n置信度：${r.confidence === null ? '未提供' : Math.round(r.confidence * 100) + '%'}\n耗时：${(r.durationMs / 1000).toFixed(2)} 秒\n模型路线：${r.route?.map((t) => `${t.provider}/${t.model} [${t.outcome}]${t.reason ? ' ' + t.reason : ''}`).join(' → ') || '未记录模型调用'}\n备注：${r.reason ?? ''}\n${r.notices?.join('\n') ?? ''}`,
      ),
    ]),
  ].join('\n\n');
}
export const EndResultSchema = z.object({
  report: RunReportSchema,
  downloadId: z.number().int().nonnegative(),
  filename: z.string().max(200),
});
export type EndResult = z.infer<typeof EndResultSchema>;
export function reportFilename(report: RunReport) {
  const timestamp =
    report.endedAt.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'report';
  return `autoffer-report-${timestamp}.md`;
}
export function downloadReport(document: Document, report: RunReport) {
  const url = URL.createObjectURL(
    new Blob([formatReport(report)], { type: 'text/markdown;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = reportFilename(report);
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
