import { z } from 'zod';
import { EditorTicketSchema } from './programming';
import { normalizeBaseUrl } from './connections';
import { AppError } from './errors';
import {
  ClassificationSchema,
  classificationIssue,
  classificationOf,
  interactionKind,
} from './classification';

export const OptionSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().max(100),
  text: z.string().max(8_000),
});
export const QuestionSchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: z.enum(['single', 'multiple', 'text', 'personal']),
    typeLabel: z.string().max(40).optional(),
    isExample: z.boolean().optional(),
    programmingLanguage: z.string().min(1).max(80).optional(),
    section: z
      .object({
        id: z.string().max(200),
        index: z.number().int().min(1).max(1000),
      })
      .optional(),
    classification: ClassificationSchema.optional(),
    stem: z.string().min(1).max(16_000),
    material: z.string().max(32_000),
    options: z.array(OptionSchema).max(50),
    hasVisual: z.boolean(),
    visuals: z
      .array(
        z.object({
          id: z.string().max(80),
          fingerprint: z.string().max(80),
          kind: z.enum(['image', 'svg', 'canvas', 'math', 'unsupported']),
          optionId: z.string().max(100).optional(),
          x: z.number().finite(),
          y: z.number().finite(),
          width: z.number().nonnegative().finite(),
          height: z.number().nonnegative().finite(),
          viewportWidth: z.number().nonnegative().finite(),
          viewportHeight: z.number().nonnegative().finite(),
          ready: z.boolean(),
          obscured: z.boolean(),
        }),
      )
      .max(20)
      .optional(),
    warnings: z.array(z.string().max(500)).max(20),
  })
  .refine(
    (question) =>
      !question.classification ||
      interactionKind(question.classification) === question.kind,
    {
      message: 'Classification and interaction kind disagree',
      path: ['classification'],
    },
  );
export type Question = z.infer<typeof QuestionSchema>;
export const PlatformInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  status: z.enum(['demo', 'experimental', 'verified']),
});
export const ScanSchema = z.object({
  platform: PlatformInfoSchema.nullable(),
  questions: z.array(QuestionSchema).max(100),
  warnings: z.array(z.string()).max(100),
});
export type Scan = z.infer<typeof ScanSchema>;
export const SnapshotSchema = ScanSchema.extend({
  scanId: z.string(),
  tabId: z.number().int(),
  page: z.string(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const SettingsSchema = z
  .object({
    // Preserve the destination of existing v0.1 settings lacking this field.
    provider: z
      .enum(['typesafe', 'vercel', 'jev-agent', 'openrouter', 'custom'])
      .default('typesafe'),
    model: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@+\-]*$/)
      .max(200)
      .default('jev-latest'),
    baseUrl: z.string().trim().max(2048).optional(),
    autoAnswer: z.boolean().optional(),
    vision: z.boolean().optional(),
    reviewThreshold: z.number().min(0.5).max(1).default(0.8),
  })
  .refine(
    (value) =>
      value.provider === 'vercel'
        ? value.model === 'typesafe-ai/jev'
        : value.provider === 'typesafe' || value.provider === 'jev-agent'
          ? /^jev-[a-zA-Z0-9.\-]+$/.test(value.model)
          : true,
    { message: '接入渠道和模型名称不匹配。' },
  )
  .superRefine((value, ctx) => {
    if (value.provider !== 'custom') return;
    try {
      normalizeBaseUrl(value.baseUrl ?? '');
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'Invalid base URL',
      });
    }
  });
export type Settings = z.infer<typeof SettingsSchema>;
// Storage accepts unfinished input. Only activation/inference uses SettingsSchema.
export const SettingsDraftSchema = z.object({
  ...SettingsSchema.shape,
  model: z.string().max(200).default(''),
  baseUrl: z.string().max(2048).optional(),
});
export type SettingsDraft = z.infer<typeof SettingsDraftSchema>;
export const ApiKeySchema = z
  .string()
  .trim()
  .regex(/^[\x21-\x7e]+$/)
  .max(16384);

export function validateModelSettings(input: SettingsDraft): Settings {
  const result = SettingsSchema.safeParse(input);
  if (result.success) return result.data;
  const field = result.error.issues[0]?.path[0];
  throw new AppError(
    'SETTINGS',
    field === 'model'
      ? '模型名称无效：请填写渠道支持的 Model ID，不能含空格。'
      : field === 'baseUrl'
        ? 'Base URL 无效：请填写 HTTPS 基础地址，不含密钥、查询参数或 /chat/completions。'
        : '接入渠道和模型名称不匹配，请检查模型配置。',
  );
}

export function validateApiKey(input: string): string {
  if (!input.trim())
    throw new AppError('NO_KEY', '请先填写此地址的 API Key，再打开开关。');
  const result = ApiKeySchema.safeParse(input);
  if (!result.success)
    throw new AppError(
      'SETTINGS',
      'API Key 格式无效：请只填写 Key，不要带 Bearer 前缀、空格或换行。',
    );
  return result.data;
}
export const SettingsViewSchema = SettingsSchema.safeExtend({
  hasKey: z.boolean(),
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;

export const SuggestionSchema = z.object({
  questionId: z.string(),
  provider: z.string(),
  model: z.string(),
  selectedIds: z.array(z.string()),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
  confidence: z.number().min(0).max(1).nullable(),
  probabilityKind: z.enum(['distribution', 'independent', 'unavailable']),
  needsReview: z.boolean(),
  lowConfidence: z.boolean().optional(),
  answerText: z.string().max(20000).optional(),
  editor: EditorTicketSchema.optional(),
  manualOnly: z.boolean().optional(),
  route: z
    .array(
      z.object({
        provider: z.string(),
        model: z.string(),
        outcome: z.enum(['success', 'failed', 'low-confidence', 'unavailable']),
        reason: z.string().optional(),
      }),
    )
    .optional(),
  notices: z.array(z.string()),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

export function unsupportedReason(question: Question): string | null {
  const issue = classificationIssue(question);
  if (issue) return issue;
  if (question.kind === 'text')
    return `${question.typeLabel ?? '自由文本题'}暂不自动作答。`;
  if (question.hasVisual)
    return '本题包含图片、公式或图形；当前接入仅发送文本，暂不支持此题。';
  if (
    classificationOf(question).format === 'true-false' &&
    question.options.length !== 2
  )
    return '判断题必须有两个可读取选项。';
  if (question.warnings.length) return '题目识别不完整，请先检查平台模板。';
  if (
    question.options.length < 2 ||
    question.options.some((option) => !option.text)
  )
    return '选项不完整，请检查平台模板。';
  return null;
}

export function inferenceIssue(question: Question): string | null {
  if (question.isExample) return '输入输出例题不计分，不调用模型。';
  const issue = classificationIssue(question);
  if (issue) return issue;
  if (
    classificationOf(question).format === 'true-false' &&
    question.options.length !== 2
  )
    return '判断题必须有两个可读取选项。';
  if (question.warnings.length) return '题目识别不完整，请先检查平台模板。';
  if (
    ['single', 'multiple'].includes(question.kind) &&
    (question.options.length < 2 ||
      question.options.some(
        (o) => !o.text && !question.visuals?.some((v) => v.optionId === o.id),
      ))
  )
    return '选项不完整，请检查平台模板。';
  if (
    question.hasVisual &&
    (!question.visuals?.length ||
      question.visuals.some((v) => v.kind === 'unsupported'))
  )
    return '图片、音视频或图形内容尚未完整适配，暂不发送模型。';
  return null;
}

export function semanticQuestion(question: Question) {
  return {
    // Canonical property order: custom adapters may append metadata after extraction,
    // while Zod reconstructs it in schema order. Neither is a semantic page change.
    id: question.id,
    ...(question.isExample !== undefined
      ? { isExample: question.isExample }
      : {}),
    kind: question.kind,
    ...(question.typeLabel !== undefined
      ? { typeLabel: question.typeLabel }
      : {}),
    ...(question.classification
      ? { classification: ClassificationSchema.parse(question.classification) }
      : {}),
    ...(question.section ? { section: question.section } : {}),
    stem: question.stem,
    material: question.material,
    options: question.options.map(({ id, label, text }) => ({
      id,
      label,
      text,
    })),
    hasVisual: question.hasVisual,
    warnings: question.warnings,
    ...(question.visuals
      ? {
          visuals: question.visuals.map(
            ({ id, fingerprint, kind, optionId }) => ({
              id,
              fingerprint,
              kind,
              optionId,
            }),
          ),
        }
      : {}),
  };
}
