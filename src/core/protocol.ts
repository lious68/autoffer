import type { ToolState } from './tool-state';
import { z } from 'zod';
import type { CodeResult } from './programming';
import { AppError } from './errors';
import { RunReportSchema, type RunReport, type EndResult } from './report';
import {
  RoutingSettingsSchema,
  type RoutingView,
  type RoutingSettings,
} from './routing';
import {
  SettingsSchema,
  SettingsDraftSchema,
  type SettingsView,
  type Snapshot,
  type Suggestion,
  type Settings,
} from './schema';

export const RequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('code:command'),
    tabId: z.number().int().nonnegative(),
    token: z.string().min(1).max(100),
    action: z.enum(['fill', 'run', 'submit', 'poll', 'cancel']),
    code: z.string().max(20000).optional(),
  }),
  z.object({
    type: z.literal('model:save'),
    slot: z.enum(['jev', 'chat']),
    settings: SettingsDraftSchema,
    apiKey: z.string().max(16384).optional(),
  }),
  z.object({
    type: z.literal('model:toggle'),
    slot: z.enum(['jev', 'chat']),
    enabled: z.boolean(),
    permissionGranted: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('model:remove-key'),
    slot: z.enum(['jev', 'chat']),
  }),
  z.object({
    type: z.literal('routing:preferences'),
    reviewThreshold: z.number().min(0.5).max(1),
    autoAnswer: z.boolean(),
  }),
  z.object({
    type: z.literal('tools:state'),
    tabId: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('report:save'),
    tabId: z.number().int().nonnegative(),
    report: RunReportSchema,
  }),
  z.object({
    type: z.literal('tools:end'),
    tabId: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('routing:get') }),
  z.object({
    type: z.literal('routing:save'),
    config: RoutingSettingsSchema,
    jevApiKey: z
      .string()
      .trim()
      .regex(/^[\x21-\x7e]+$/)
      .max(16384)
      .optional(),
    chatApiKey: z
      .string()
      .trim()
      .regex(/^[\x21-\x7e]+$/)
      .max(16384)
      .optional(),
    removeJevKey: z.boolean().optional(),
    removeChatKey: z.boolean().optional(),
  }),
  z.object({ type: z.literal('settings:get') }),
  z.object({
    type: z.literal('settings:save'),
    settings: SettingsSchema,
    apiKey: z
      .string()
      .trim()
      .regex(/^[\x21-\x7e]+$/)
      .max(16_384)
      .optional(),
    removeKey: z.boolean().optional(),
  }),
  z.object({ type: z.literal('scan'), tabId: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('tools:open'),
    tabId: z.number().int().nonnegative(),
    autoAnswer: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('tools:stop'),
    tabId: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('tools:show'),
    tabId: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('suggest'),
    tabId: z.number().int().nonnegative(),
    scanId: z.string().max(100),
    questionId: z.string().max(200),
  }),
  z.object({
    type: z.literal('cancel'),
    tabId: z.number().int().nonnegative(),
  }),
]);
export type Request = z.infer<typeof RequestSchema>;

/** Field diagnostics must never include credential values or raw Zod issues. */
export function parseRequest(raw: unknown): Request {
  const result = RequestSchema.safeParse(raw);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.join('.');
  let message = '扩展请求无效。请重新加载 AutOffer，再点击工具栏图标打开配置。';
  if (['apiKey', 'jevApiKey', 'chatApiKey'].includes(field ?? '')) {
    message =
      issue?.code === 'too_big'
        ? 'API Key 超过 16384 字符，请确认只粘贴了 Key，没有附带代码或整段响应。'
        : 'API Key 格式无效：请只粘贴 Key 本身，不要带 Bearer 前缀、引号、内部空格或换行。';
  } else if (field === 'settings.model' || field?.endsWith('.model')) {
    message =
      '模型名称无效：请填写渠道支持的 Model ID，不能含空格；Jev 渠道需使用指定模型。';
  } else if (field === 'settings.baseUrl' || field?.endsWith('.baseUrl')) {
    message =
      'Base URL 无效：请使用 HTTPS 基础地址（通常以 /v1 结尾），不含密钥、查询参数或 /chat/completions。';
  } else if (field === 'settings.provider') {
    message = '接入渠道无效，请重新选择。';
  } else if (
    field === 'settings.reviewThreshold' ||
    field === 'reviewThreshold'
  ) {
    message = '低置信度提醒阈值必须是 0.5 到 1 之间的数字。';
  } else if (field === 'settings') {
    message =
      '接入渠道和模型名称不匹配。请重新选择渠道，使用自动填入的模型名称后保存。';
  } else if (field?.startsWith('config')) {
    message = '双模型配置无效，请检查各自的渠道、模型、HTTPS Base URL 和阈值。';
  } else if (field === 'tabId') {
    message = '没有获取到有效网页标签，请回到目标网页后重新点击扩展图标。';
  }
  throw new AppError('BAD_REQUEST', message);
}
export type Reply =
  | {
      ok: true;
      data:
        | SettingsView
        | RoutingView
        | Snapshot
        | Suggestion
        | RunReport
        | EndResult
        | CodeResult
        | ToolState
        | null;
    }
  | { ok: false; error: { code: string; message: string } };
export interface Client {
  getPanelView?(): Promise<'run' | 'models'>;
  setPanelView?(view: 'run' | 'models'): Promise<void>;
  authorizeConnection?(settings: Settings): Promise<boolean>;
  authorizeRoutes?(settings: RoutingSettings): Promise<boolean>;
  request(request: Request): Promise<unknown>;
  activeTabId(): Promise<number>;
  /** Invalidate results when the active page changes. */
  onPageChange(callback: () => void): () => void;
}
