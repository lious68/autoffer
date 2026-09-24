import { z } from 'zod';
import { AppError } from '../core/errors';
import { astraFlow, connectionFor } from '../core/connections';
import { validateApiKey, validateModelSettings } from '../core/schema';
import type { RouteCredential } from '../core/routing';
import { providerHttpError } from './http-error';

const ChatReply = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.enum([
          'stop',
          'length',
          'content_filter',
          'tool_calls',
          'function_call',
        ]),
        message: z.object({
          content: z.string().trim().nullable().optional(),
          reasoning_content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
        }),
      }),
    )
    .length(1),
});
const JevReply = z.object({
  answers: z.object({
    ping: z.object({
      type: z.literal('noul'),
      noul: z.number().finite().min(0).max(1),
    }),
  }),
});

async function boundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('BAD_RESPONSE', '验证接口返回了空响应。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024)
        throw new AppError('BAD_RESPONSE', '验证响应过大，请检查模型接口。');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new AppError(
        'BAD_RESPONSE',
        '验证接口未返回有效 JSON，请检查基础地址。',
      );
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** One synthetic request to the selected model only. No page data, retries or fallback. */
export function createModelVerifier(
  fetcher: typeof fetch = fetch,
  timeoutMs = 15_000,
) {
  return async (
    { settings: input, apiKey: inputKey }: RouteCredential,
    parent: AbortSignal,
  ): Promise<void> => {
    const settings = validateModelSettings(input);
    const apiKey = validateApiKey(inputKey);
    const connection = connectionFor(settings);
    const chat =
      settings.provider === 'custom' || settings.provider === 'openrouter';
    const state = { ping: true };
    const body = chat
      ? {
          model: settings.model,
          stream: false,
          max_tokens: 64,
          ...(settings.provider === 'custom' &&
          settings.baseUrl === astraFlow.baseUrl &&
          settings.model === astraFlow.model
            ? { thinking: { type: 'disabled' } }
            : {}),
          messages: [{ role: 'user', content: 'Reply OK.' }],
        }
      : {
          model: settings.model,
          state:
            settings.provider === 'jev-agent' ? JSON.stringify(state) : state,
          questions: {
            ping: {
              type: 'noul',
              instructions: 'Is state.ping true?',
              criteria: { true: 'Yes', false: 'No' },
            },
          },
        };
    const deadline = new AbortController();
    const signal = AbortSignal.any([parent, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    try {
      if (signal.aborted) throw new AppError('CANCELLED', '模型验证已取消。');
      const response = await fetcher(connection.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
        credentials: 'omit',
        redirect: 'error',
      });
      if (!response.ok) {
        if (settings.provider === 'jev-agent' && response.status === 429)
          throw new AppError('CREDIT', 'Jev Agent 额度已用尽（HTTP 429）。');
        throw await providerHttpError(response, connection.label);
      }
      const raw = await boundedJson(response);
      if (chat) {
        const parsed = ChatReply.safeParse(raw);
        if (!parsed.success)
          throw new AppError(
            'BAD_RESPONSE',
            '验证接口响应结构异常，未取得有效的 Chat Completions 结果。',
          );
        const choice = parsed.data.choices[0]!;
        if (choice.message.refusal || choice.finish_reason === 'content_filter')
          throw new AppError(
            'BAD_RESPONSE',
            '模型拒绝了测试请求，验证未通过。',
          );
        if (choice.finish_reason === 'length')
          throw new AppError(
            'BAD_RESPONSE',
            '测试输出达到 token 上限，未完整返回；模型可能仍在思考，请稍后重试。',
          );
        if (choice.finish_reason !== 'stop')
          throw new AppError(
            'BAD_RESPONSE',
            '模型返回了工具调用，未完成文本验证。',
          );
        if (!choice.message.content)
          throw new AppError(
            'BAD_RESPONSE',
            choice.message.reasoning_content?.trim()
              ? '模型只返回了思考内容，没有最终正文，验证未通过。'
              : '模型返回了空正文，验证未通过，请稍后重试。',
          );
      } else if (!JevReply.safeParse(raw).success) {
        throw new AppError(
          'BAD_RESPONSE',
          'Jev 未返回有效判断结果，验证失败。',
        );
      }
      if (signal.aborted) throw new AppError('CANCELLED', '模型验证已取消。');
    } catch (error) {
      if (parent.aborted) throw new AppError('CANCELLED', '模型验证已取消。');
      if (deadline.signal.aborted)
        throw new AppError('TIMEOUT', '模型验证超时，请检查地址或稍后重试。');
      if (error instanceof AppError) throw error;
      throw new AppError(
        'NETWORK',
        '无法连接模型，请检查地址、网络或网站访问权限。',
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
