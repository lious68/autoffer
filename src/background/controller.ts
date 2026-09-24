import { isAcm, type EditorTicket } from '../core/programming';
import { AppError } from '../core/errors';
import { parseRequest } from '../core/protocol';
import {
  ScanSchema,
  inferenceIssue,
  semanticQuestion,
  type Scan,
  type Settings,
  type Snapshot,
  type Question,
} from '../core/schema';
import type { AnswerProvider } from '../providers/types';
import type {
  RoutingSettings,
  RouteCredentials,
  RouteCredential,
  ModelSlot,
  ModelStates,
} from '../core/routing';

export interface PageScan {
  scan: Scan;
  documentId: string;
  page: string;
}
export interface Vault {
  readRoutes?(): Promise<{
    config: RoutingSettings;
    credentials: RouteCredentials;
    keysPresent?: Record<ModelSlot, boolean>;
    modelStates?: ModelStates;
  }>;
  saveModel?(
    slot: ModelSlot,
    settings: Settings,
    apiKey?: string,
  ): Promise<void>;
  toggleModel?(
    slot: ModelSlot,
    enabled: boolean,
    allowed?: (settings: Settings) => Promise<boolean>,
    verify?: (
      credentials: RouteCredential,
      signal: AbortSignal,
    ) => Promise<void>,
  ): Promise<void>;
  removeModelKey?(slot: ModelSlot): Promise<void>;
  savePreferences?(reviewThreshold: number, autoAnswer: boolean): Promise<void>;
  saveRoutes?(value: {
    config: RoutingSettings;
    jevApiKey?: string | undefined;
    chatApiKey?: string | undefined;
    removeJevKey?: boolean | undefined;
    removeChatKey?: boolean | undefined;
  }): Promise<void>;
  read(): Promise<{ apiKey: string; settings: Settings }>;
  save(value: {
    settings: Settings;
    apiKey?: string | undefined;
    removeKey?: boolean | undefined;
  }): Promise<void>;
}
export interface ControllerDependencies {
  prepareProgramming?(tabId: number, question: Question): Promise<EditorTicket>;
  scan(tabId: number): Promise<PageScan>;
  vault: Vault;
  provider: AnswerProvider;
  hasPermission?(settings: Settings): Promise<boolean>;
  verifyModel?(
    credentials: RouteCredential,
    signal: AbortSignal,
  ): Promise<void>;
  timeoutMs?: number;
  captureImages?(
    tabId: number,
    question: Question,
  ): Promise<Array<{ id: string; dataUrl: string }>>;
}

export class Controller {
  private readonly snapshots = new Map<
    number,
    { snapshot: Snapshot; documentId: string }
  >();
  private readonly jobs = new Map<number, AbortController>();
  private readonly generations = new Map<number, number>();
  constructor(private readonly dependencies: ControllerDependencies) {}

  invalidate(tabId: number): void {
    this.jobs.get(tabId)?.abort();
    this.snapshots.delete(tabId);
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
  }

  async handle(raw: unknown) {
    const request = parseRequest(raw);
    switch (request.type) {
      case 'model:save':
      case 'model:toggle':
      case 'model:remove-key':
      case 'routing:preferences': {
        for (const job of this.jobs.values()) job.abort();
        const vault = this.dependencies.vault;
        if (request.type === 'model:save' && vault.saveModel)
          await vault.saveModel(request.slot, request.settings, request.apiKey);
        else if (request.type === 'model:toggle' && vault.toggleModel)
          await vault.toggleModel(
            request.slot,
            request.enabled,
            async (settings) =>
              request.permissionGranted !== false &&
              (this.dependencies.hasPermission
                ? await this.dependencies.hasPermission(settings)
                : true),
            this.dependencies.verifyModel,
          );
        else if (request.type === 'model:remove-key' && vault.removeModelKey)
          await vault.removeModelKey(request.slot);
        else if (
          request.type === 'routing:preferences' &&
          vault.savePreferences
        )
          await vault.savePreferences(
            request.reviewThreshold,
            request.autoAnswer,
          );
        else
          throw new AppError('SETTINGS', '请重新加载扩展以更新模型配置功能。');
        return this.routingView();
      }
      case 'routing:get':
        return this.routingView();
      case 'routing:save':
        for (const job of this.jobs.values()) job.abort();
        if (!this.dependencies.vault.saveRoutes)
          throw new AppError('SETTINGS', '后台尚未支持双模型配置。');
        await this.dependencies.vault.saveRoutes(request);
        return this.routingView();
      case 'settings:get':
        return this.settingsView();
      case 'settings:save':
        for (const job of this.jobs.values()) job.abort();
        await this.dependencies.vault.save(request);
        return this.settingsView();
      case 'cancel':
        this.jobs.get(request.tabId)?.abort();
        return null;
      case 'scan': {
        this.invalidate(request.tabId);
        const generation = this.generations.get(request.tabId);
        const page = await this.dependencies.scan(request.tabId);
        if (this.generations.get(request.tabId) !== generation)
          throw new AppError('STALE', '页面已变化，请重新识别。');
        const snapshot: Snapshot = {
          ...ScanSchema.parse(page.scan),
          scanId: crypto.randomUUID(),
          tabId: request.tabId,
          page: page.page,
        };
        // Bounded in-memory cache. Worker restart intentionally requires another scan.
        if (this.snapshots.size >= 10) {
          const oldest = this.snapshots.keys().next().value;
          if (oldest !== undefined) this.invalidate(oldest);
        }
        this.snapshots.set(request.tabId, {
          snapshot,
          documentId: page.documentId,
        });
        return snapshot;
      }
      case 'suggest': {
        const cached = this.snapshots.get(request.tabId);
        if (!cached || cached.snapshot.scanId !== request.scanId)
          throw new AppError('STALE', '识别结果已失效，请重新识别当前页。');
        if (this.jobs.size >= 3 || this.jobs.has(request.tabId))
          throw new AppError('BUSY', '已有请求处理中，请等待或停止后再试。');
        const question = cached.snapshot.questions.find(
          (entry) => entry.id === request.questionId,
        );
        if (!question)
          throw new AppError('STALE', '找不到这道题，请重新识别。');
        const reason = inferenceIssue(question);
        if (reason) throw new AppError('UNSUPPORTED', reason);
        const job = new AbortController();
        this.jobs.set(request.tabId, job);
        const timer = setTimeout(
          () => job.abort(),
          this.dependencies.timeoutMs ?? 90_000,
        );
        const assertCurrent = async () => {
          const current = await this.dependencies.scan(request.tabId);
          const currentQuestion = current.scan.questions.find(
            (entry) => entry.id === question.id,
          );
          if (job.signal.aborted)
            throw new AppError('CANCELLED', '请求已停止或超时。');
          if (
            this.snapshots.get(request.tabId) !== cached ||
            current.documentId !== cached.documentId ||
            current.page !== cached.snapshot.page ||
            !currentQuestion ||
            JSON.stringify(semanticQuestion(currentQuestion)) !==
              JSON.stringify(semanticQuestion(question))
          ) {
            this.invalidate(request.tabId);
            throw new AppError(
              'STALE',
              '页面或题目已变化，请重新识别；旧结果已丢弃。',
            );
          }
          return currentQuestion;
        };
        try {
          await assertCurrent();
          const credentials = await this.dependencies.vault.read();
          const routeConfig = await this.dependencies.vault.readRoutes?.();
          if (job.signal.aborted)
            throw new AppError('CANCELLED', '请求已停止或超时。');
          const editor =
            isAcm(question) && this.dependencies.prepareProgramming
              ? await this.dependencies.prepareProgramming(
                  request.tabId,
                  question,
                )
              : undefined;
          if (job.signal.aborted)
            throw new AppError('CANCELLED', '请求已停止。');
          const suggestion = await this.dependencies.provider.suggest(
            editor
              ? { ...question, programmingLanguage: editor.language }
              : question,
            {
              ...credentials,
              signal: job.signal,
              ...(routeConfig ? { routes: routeConfig.credentials } : {}),
              captureImages: async () => {
                if (!this.dependencies.captureImages)
                  throw new AppError(
                    'IMAGE_CAPTURE',
                    '当前环境尚未支持图片截取。',
                  );
                const fresh = await assertCurrent();
                const images = await this.dependencies.captureImages(
                  request.tabId,
                  fresh,
                );
                const after = await assertCurrent();
                if (
                  JSON.stringify(fresh.visuals) !==
                  JSON.stringify(after.visuals)
                )
                  throw new AppError(
                    'IMAGE_CAPTURE',
                    '截取时图像位置或页面尺寸发生变化，本次图像已丢弃，请保持页面稳定。',
                  );
                return images;
              },
            },
          );
          await assertCurrent();
          return editor ? { ...suggestion, editor } : suggestion;
        } finally {
          clearTimeout(timer);
          if (this.jobs.get(request.tabId) === job)
            this.jobs.delete(request.tabId);
        }
      }
    }
  }

  private async settingsView() {
    const { apiKey, settings } = await this.dependencies.vault.read();
    return { ...settings, hasKey: Boolean(apiKey) };
  }
  private async routingView() {
    if (!this.dependencies.vault.readRoutes)
      throw new AppError('SETTINGS', '后台尚未支持双模型配置。');
    const { config, credentials, keysPresent, modelStates } =
      await this.dependencies.vault.readRoutes();
    return {
      ...config,
      hasJevKey: keysPresent?.jev ?? Boolean(credentials.jev?.apiKey),
      hasChatKey: keysPresent?.chat ?? Boolean(credentials.chat?.apiKey),
      ...(modelStates ? { modelStates } : {}),
    };
  }
}
