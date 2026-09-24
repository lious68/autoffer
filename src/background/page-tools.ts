import {
  EditorTicketSchema,
  CodeResultSchema,
  type CodeCommand,
} from '../core/programming';
import { ToolStateSchema, idleToolState } from '../core/tool-state';
import { AppError } from '../core/errors';
import { parseRequest } from '../core/protocol';
import { RunReportSchema, type RunReport } from '../core/report';

/** Page tools can request inference and save reports only for their enabled document. */
export class PageTools {
  private readonly documents = new Map<number, string>();
  constructor(
    private readonly scripting: Pick<typeof chrome.scripting, 'executeScript'>,
    private readonly storage?: Pick<
      typeof chrome.storage.session,
      'get' | 'set' | 'remove'
    >,
  ) {}

  async code(tabId: number, command: CodeCommand) {
    const documentId = await this.document(tabId);
    if (
      !documentId ||
      (!(await this.state(tabId)).running && command.action !== 'cancel')
    )
      throw new AppError('CANCELLED', '作答已停止，未操作代码。');
    const target = { tabId, documentIds: [documentId] };
    await this.scripting.executeScript({
      target,
      world: 'MAIN',
      files: ['acm-main.js'],
    });
    // Check the isolated session again after injection; popup close is not cancellation.
    if (!(await this.state(tabId)).running && command.action !== 'cancel')
      throw new AppError('CANCELLED', '作答已停止，未操作代码。');
    const results = await this.scripting.executeScript({
      target,
      world: 'MAIN',
      func: (input: CodeCommand) => {
        try {
          return { value: globalThis.AutofferAcm?.(input) };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : '代码操作失败。',
          };
        }
      },
      args: [command],
    });
    const result = results[0]?.result;
    if (!result || result.error)
      throw new AppError('CODE_ACTION', result?.error ?? '代码桥接未初始化。');
    if (command.action === 'cancel') return null;
    return command.action === 'prepare'
      ? EditorTicketSchema.parse(result.value)
      : CodeResultSchema.parse(result.value);
  }

  async invalidate(tabId: number) {
    this.documents.delete(tabId);
    await this.storage?.remove(`tool-document:${tabId}`);
  }

  async open(tabId: number, autoAnswer = true) {
    const injected = await this.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
      world: 'ISOLATED',
    });
    const documentId = injected[0]?.documentId;
    if (!documentId)
      throw new AppError(
        'DOCUMENT_MISSING',
        '无法确认当前文档，请重新点击扩展图标。',
      );
    this.documents.set(tabId, documentId);
    await this.storage?.set({ [`tool-document:${tabId}`]: documentId });
    try {
      const result = await this.scripting.executeScript({
        target: { tabId, documentIds: [documentId] },
        world: 'ISOLATED',
        func: (mode: boolean) => globalThis.AutofferContent?.openTools(mode),
        args: [autoAnswer],
      });
      if (result[0]?.result !== true) throw new Error('not mounted');
    } catch {
      await this.invalidate(tabId);
      throw new AppError(
        'TOOLS_UNAVAILABLE',
        '悬浮球初始化失败，请在普通网页点击扩展图标后重新启用。',
      );
    }
    return null;
  }

  private async document(tabId: number) {
    const saved = (await this.storage?.get(`tool-document:${tabId}`))?.[
      `tool-document:${tabId}`
    ];
    return this.storage
      ? typeof saved === 'string'
        ? saved
        : undefined
      : this.documents.get(tabId);
  }

  async state(tabId: number) {
    const documentId = await this.document(tabId);
    const fallback = async () => {
      const saved = (await this.storage?.get(`tool-report:${tabId}`))?.[
        `tool-report:${tabId}`
      ];
      return {
        ...idleToolState,
        ...(RunReportSchema.safeParse(saved).success
          ? { started: true, ended: true }
          : {}),
      };
    };
    if (!documentId) return fallback();
    const results = await this.scripting
      .executeScript({
        target: { tabId, documentIds: [documentId] },
        world: 'ISOLATED',
        func: () => globalThis.AutofferContent?.getToolsState?.() ?? null,
      })
      .catch(() => []);
    const raw = results[0]?.result;
    return raw ? ToolStateSchema.parse(raw) : fallback();
  }

  async control(tabId: number, action: 'stop' | 'show') {
    const documentId = await this.document(tabId);
    if (!documentId) return null;
    await this.scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      world: 'ISOLATED',
      func: (command: 'stop' | 'show') =>
        command === 'stop'
          ? globalThis.AutofferContent?.stopTools()
          : globalThis.AutofferContent?.showTools(),
      args: [action],
    });
    return null;
  }

  async stopAll() {
    const saved = (await this.storage?.get(null)) ?? {};
    const ids = new Set([
      ...this.documents.keys(),
      ...Object.keys(saved)
        .filter((k) => /^tool-document:\d+$/.test(k))
        .map((k) => Number(k.split(':')[1])),
    ]);
    await Promise.all(
      [...ids].map((tabId) =>
        this.control(tabId, 'stop').catch(() => undefined),
      ),
    );
  }

  async saveReport(tabId: number, raw: RunReport) {
    const report = RunReportSchema.parse(raw);
    await this.storage?.set({ [`tool-report:${tabId}`]: report });
    return report;
  }
  async savedReport(tabId: number) {
    const saved = (await this.storage?.get(`tool-report:${tabId}`))?.[
      `tool-report:${tabId}`
    ];
    return saved ? RunReportSchema.parse(saved) : null;
  }
  async end(tabId: number) {
    const documentId = await this.document(tabId);
    if (documentId) {
      const results = await this.scripting
        .executeScript({
          target: { tabId, documentIds: [documentId] },
          world: 'ISOLATED',
          func: () => globalThis.AutofferContent?.endTools(),
        })
        .catch(() => []);
      if (results[0]?.result)
        return this.saveReport(tabId, RunReportSchema.parse(results[0].result));
    }
    const saved = (await this.storage?.get(`tool-report:${tabId}`))?.[
      `tool-report:${tabId}`
    ];
    return saved ? RunReportSchema.parse(saved) : null;
  }

  async request(raw: unknown, sender: chrome.runtime.MessageSender) {
    const tabId = sender.tab?.id;
    if (
      tabId === undefined ||
      sender.frameId !== 0 ||
      !sender.documentId ||
      (await this.document(tabId)) !== sender.documentId
    )
      throw new AppError(
        'TOOLS_EXPIRED',
        '页面已重新加载，请从工具栏配置面板重新启用悬浮球。',
      );
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('type' in raw) ||
      !['scan', 'suggest', 'cancel', 'report:save', 'code:command'].includes(
        String(raw.type),
      )
    )
      throw new AppError('BAD_REQUEST', '不支持的页面工具请求。');
    return parseRequest({ ...raw, tabId });
  }
}
