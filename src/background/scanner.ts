import { AppError } from '../core/errors';
import { ScanSchema } from '../core/schema';
import type { PageScan } from './controller';

type Scripting = Pick<typeof chrome.scripting, 'executeScript'>;

function injectionError(error: unknown, stage: 'inject' | 'read'): AppError {
  const message = error instanceof Error ? error.message : '';
  if (
    /cannot access|permission|not allowed|extensions gallery/i.test(message)
  ) {
    return new AppError(
      'PAGE_PERMISSION',
      '浏览器未授予当前页的读取权限。请点击浏览器工具栏中的 AutOffer 图标后重试。',
    );
  }
  if (
    /no tab|closed|no frame|no document|removed|frame.*not found/i.test(message)
  ) {
    return new AppError(
      'PAGE_CHANGED',
      '目标网页已关闭或发生跳转，请回到目标页后重新识别。',
    );
  }
  return new AppError(
    stage === 'inject' ? 'INJECT_FAILED' : 'SCAN_FAILED',
    stage === 'inject'
      ? '识题脚本注入失败（INJECT_FAILED）。请在扩展管理页重新加载 AutOffer。'
      : '读取题目时脚本执行失败（SCAN_FAILED）。请反馈此错误码。',
  );
}

export function createPageScanner(
  scripting: Scripting,
): (tabId: number) => Promise<PageScan> {
  return async (tabId) => {
    let injected: chrome.scripting.InjectionResult[];
    try {
      injected = await scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
        world: 'ISOLATED',
      });
    } catch (error) {
      throw injectionError(error, 'inject');
    }
    const documentId = injected[0]?.documentId;
    if (!documentId)
      throw new AppError(
        'DOCUMENT_MISSING',
        '浏览器未返回文档标识（DOCUMENT_MISSING）。请检查浏览器版本。',
      );
    let results;
    try {
      results = await scripting.executeScript({
        // Bind the read to the document we injected into, not a new page after navigation.
        target: { tabId, documentIds: [documentId] },
        world: 'ISOLATED',
        func: () => {
          const scanner = globalThis.AutofferContent;
          if (!scanner || typeof scanner.scanCurrentPage !== 'function')
            return null;
          return {
            scan: scanner.scanCurrentPage(),
            page: location.origin + location.pathname,
          };
        },
      });
    } catch (error) {
      throw injectionError(error, 'read');
    }
    const result = results[0];
    if (!result?.result)
      throw new AppError(
        'SCANNER_MISSING',
        '识题脚本未正确初始化（SCANNER_MISSING）。请重新加载 AutOffer。',
      );
    if (result.documentId !== documentId)
      throw new AppError('PAGE_CHANGED', '页面已变化，请重新识别。');
    const parsed = ScanSchema.safeParse(result.result.scan);
    if (!parsed.success)
      throw new AppError(
        'SCAN_INVALID',
        '页面已读取，但模板返回了无效数据（SCAN_INVALID）。请反馈此错误码。',
      );
    return { scan: parsed.data, page: result.result.page, documentId };
  };
}
