import type { PlatformAdapter, PlatformContext } from './types';
import { ScanSchema, type Scan } from '../core/schema';
import demo from './demo';
import nowcoder from './nowcoder';
import wjx from './wjx';

// Explicit registration keeps supported platforms reviewable in pull requests.
export const platforms: readonly PlatformAdapter[] = [demo, nowcoder, wjx];

export function scanPage(context: PlatformContext, adapters = platforms): Scan {
  try {
    const adapter = matchPlatform(context, adapters);
    if (!adapter)
      return {
        platform: null,
        questions: [],
        warnings: [
          '这个页面还没有识题模板。可以打开演示页，或按贡献指南添加平台。',
        ],
      };
    const result = ScanSchema.parse(adapter.extract(context));
    if (result.platform?.id !== adapter.meta.id)
      throw new Error('Platform identity mismatch');
    if (!result.questions.length && !result.warnings.length)
      result.warnings.push(
        '已匹配平台，但没有找到题目。请确认题目已加载；页面结构可能已经变化。',
      );
    return result;
  } catch (error) {
    return {
      platform: null,
      questions: [],
      warnings: [
        error instanceof PlatformMatchError
          ? error.message
          : '模板解析失败。请检查选择器、题目长度及样例测试。',
      ],
    };
  }
}

class PlatformMatchError extends Error {}

export function matchPlatform(
  context: PlatformContext,
  adapters = platforms,
): PlatformAdapter | null {
  if (
    new Set(adapters.map((adapter) => adapter.meta.id)).size !== adapters.length
  )
    throw new PlatformMatchError(
      '多个平台使用同一 ID，已停止识别；请修正注册表。',
    );
  const matches = adapters.filter((adapter) => adapter.matches(context));
  if (matches.length > 1)
    throw new PlatformMatchError(
      '多个平台模板同时匹配，已停止识别；请修正模板匹配规则。',
    );
  return matches[0] ?? null;
}
