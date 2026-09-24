import type { AnswerProvider } from './types';
import { createJevProvider } from './jev';
import { createChatProvider } from './chat';
import { connectionOrigin } from '../core/connections';
import { AppError, publicError } from '../core/errors';
import { routeFor, type RouteCredentials } from '../core/routing';
import { inferenceIssue, type Suggestion } from '../core/schema';

export function createProviderRouter(
  hasPermission: (origin: string) => Promise<boolean>,
  fetcher: typeof fetch = fetch,
  timeouts = { jevMs: 15_000, chatMs: 60_000 },
): AnswerProvider {
  const jev = createJevProvider(fetcher);
  const chat = createChatProvider(fetcher);
  return {
    id: 'router',
    async suggest(question, context) {
      const issue = inferenceIssue(question);
      if (issue) throw new AppError('UNSUPPORTED', issue);
      const routes: RouteCredentials =
        context.routes ??
        (['openrouter', 'custom'].includes(context.settings.provider)
          ? { chat: { settings: context.settings, apiKey: context.apiKey } }
          : { jev: { settings: context.settings, apiKey: context.apiKey } });
      const slot = routeFor(question, routes);
      if (!slot)
        throw new AppError(
          'UNSUPPORTED',
          question.hasVisual || question.kind === 'text'
            ? '此题需要 AstraFlow，请先配置并启用。'
            : '没有可用模型 Key，请先配置 Jev 或 AstraFlow。',
        );
      const trace: NonNullable<Suggestion['route']> = [];
      if (
        slot === 'chat' &&
        !question.hasVisual &&
        ['single', 'multiple'].includes(question.kind) &&
        !routes.jev?.apiKey
      )
        trace.push({
          provider: 'Jev',
          model: '—',
          outcome: 'unavailable',
          reason: '未配置可用 Jev Key，使用通用模型。',
        });
      const run = async (which: 'jev' | 'chat') => {
        const credentials = routes[which]!;
        if (context.signal.aborted)
          throw new AppError('CANCELLED', '请求已停止。');
        if (!(await hasPermission(connectionOrigin(credentials.settings))))
          throw new AppError(
            'API_PERMISSION',
            '尚未授权此模型网站，请保存配置并允许访问该地址。',
          );
        let images = context.images;
        if (which === 'chat' && question.hasVisual) {
          if (!credentials.settings.vision)
            throw new AppError(
              'UNSUPPORTED',
              '图片题需要在通用模型配置中启用视觉能力，并选择支持图片的模型。',
            );
          if (!images) {
            if (!context.captureImages)
              throw new AppError(
                'IMAGE_CAPTURE',
                '没有可用的题目图片截取能力。',
              );
            images = await context.captureImages();
          }
        }
        const deadline = new AbortController();
        const timer = setTimeout(
          () => deadline.abort(),
          which === 'jev' ? timeouts.jevMs : timeouts.chatMs,
        );
        let result: Suggestion;
        try {
          result = await (which === 'jev' ? jev : chat).suggest(question, {
            ...context,
            ...credentials,
            signal: AbortSignal.any([context.signal, deadline.signal]),
            ...(images ? { images } : {}),
          });
          if (deadline.signal.aborted)
            throw new AppError('TIMEOUT', '模型请求超时。');
        } catch (error) {
          if (deadline.signal.aborted && !context.signal.aborted)
            throw new AppError('TIMEOUT', '模型请求超时。');
          throw error;
        } finally {
          clearTimeout(timer);
        }
        trace.push({
          provider: credentials.settings.provider,
          model: result.model,
          outcome: result.lowConfidence ? 'low-confidence' : 'success',
        });
        return result;
      };
      let result: Suggestion;
      try {
        result = await run(slot);
      } catch (error) {
        if (context.signal.aborted)
          throw new AppError('CANCELLED', '请求已停止。');
        if (slot !== 'jev' || !routes.chat?.apiKey) throw error;
        trace.push({
          provider: routes.jev!.settings.provider,
          model: routes.jev!.settings.model,
          outcome: 'failed',
          reason: publicError(error).message,
        });
        try {
          result = await run('chat');
        } catch (fallback) {
          if (context.signal.aborted)
            throw new AppError('CANCELLED', '请求已停止。');
          throw new AppError(
            'PROVIDER',
            `Jev 失败后通用模型也未成功：${publicError(fallback).message}`,
          );
        }
      }
      if (
        slot === 'jev' &&
        trace.length === 1 &&
        (result.lowConfidence || result.needsReview) &&
        routes.chat?.apiKey
      ) {
        trace[0]!.outcome = 'low-confidence';
        trace[0]!.reason = 'Jev 结果未达到自动作答阈值。';
        try {
          result = await run('chat');
        } catch (error) {
          if (context.signal.aborted)
            throw new AppError('CANCELLED', '请求已停止。');
          throw new AppError(
            'PROVIDER',
            `Jev 确定度不足，通用模型回退失败：${publicError(error).message}`,
          );
        }
      }
      return {
        ...result,
        route: trace,
        notices: [
          `模型路线：${trace.map((t) => (['typesafe', 'vercel', 'jev-agent', 'Jev'].includes(t.provider) ? 'Jev' : ['custom', 'openrouter'].includes(t.provider) ? 'AstraFlow' : t.provider) + (t.outcome === 'failed' ? '（失败）' : t.outcome === 'low-confidence' ? '（低确定度）' : '')).join(' → ')}`,
          ...result.notices,
        ],
      };
    },
  };
}
