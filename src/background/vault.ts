import { z } from 'zod';
import { AppError, publicError } from '../core/errors';
import {
  ApiKeySchema,
  SettingsSchema,
  SettingsDraftSchema,
  validateModelSettings,
  validateApiKey,
  type SettingsDraft,
} from '../core/schema';
import type { Vault } from './controller';
import { normalizeBaseUrl } from '../core/connections';
import {
  RoutingSettingsSchema,
  RoutingDraftSchema,
  ModelStatesSchema,
  type ModelState,
  type ModelSlot,
  modelEnabled,
  type RouteCredentials,
} from '../core/routing';

interface Storage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
}
const KeysSchema = z.object({
  typesafe: z.string().optional(),
  vercel: z.string().optional(),
  'jev-agent': z.string().optional(),
  openrouter: z.string().optional(),
  custom: z.record(z.string(), z.string()).optional(),
});

/** Credentials are scoped by destination. Switching never reuses another provider's key. */
export function createVault(storage: Storage, ready: Promise<void>): Vault {
  let queue: Promise<unknown> = ready;
  const revisions = { jev: 0, chat: 0 };
  const checks = new Map<ModelSlot, AbortController>();
  function invalidate(slot: ModelSlot) {
    checks.get(slot)?.abort();
    checks.delete(slot);
    return ++revisions[slot];
  }
  function keyScope(settings: SettingsDraft) {
    try {
      return normalizeBaseUrl(settings.baseUrl ?? '');
    } catch {
      return `draft:${settings.baseUrl ?? ''}`;
    }
  }
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  }
  async function load() {
    await ready;
    const stored = await storage.get(['settings', 'apiKeys', 'apiKey']);
    const settings = SettingsSchema.safeParse(
      stored.settings ?? {
        provider: typeof stored.apiKey === 'string' ? 'typesafe' : 'vercel',
        model:
          typeof stored.apiKey === 'string' ? 'jev-latest' : 'typesafe-ai/jev',
      },
    );
    const keys = KeysSchema.safeParse(stored.apiKeys ?? {});
    if (!settings.success || !keys.success)
      throw new AppError(
        'SETTINGS',
        '本机配置无效，请重新保存接入渠道和模型设置。',
      );
    // Old builds sent apiKey to TypeSafe only. Never migrate it to Vercel.
    if (typeof stored.apiKey === 'string') {
      keys.data.typesafe ??= stored.apiKey;
      await storage.set({ apiKeys: keys.data, settings: settings.data });
      await storage.remove('apiKey');
    }
    return { settings: settings.data, keys: keys.data };
  }
  function keyFor(
    keys: z.infer<typeof KeysSchema>,
    settings: ReturnType<typeof SettingsSchema.parse>,
  ) {
    return settings.provider === 'custom'
      ? (keys.custom?.[keyScope(settings)] ?? '')
      : (keys[settings.provider] ?? '');
  }
  function updateKey(
    keys: z.infer<typeof KeysSchema>,
    settings: ReturnType<typeof SettingsSchema.parse>,
    key: string | undefined,
    remove: boolean | undefined,
  ) {
    if (settings.provider === 'custom') {
      keys.custom ??= {};
      const base = keyScope(settings);
      if (remove) delete keys.custom[base];
      else if (key) keys.custom[base] = key;
    } else {
      if (remove) delete keys[settings.provider];
      else if (key) keys[settings.provider] = key;
    }
  }
  async function routing() {
    const { settings, keys } = await load();
    const stored = await storage.get(['routingConfig', 'modelStates']);
    const modelStates =
      ModelStatesSchema.safeParse(stored.modelStates ?? {}).data ?? {};
    const isChat = ['custom', 'openrouter'].includes(settings.provider);
    const config = RoutingDraftSchema.parse(
      stored.routingConfig ?? {
        jev: isChat ? null : settings,
        chat: isChat ? settings : null,
        reviewThreshold: settings.reviewThreshold,
        autoAnswer: settings.autoAnswer ?? true,
      },
    );
    const keysPresent = {
      jev: Boolean(config.jev && keyFor(keys, config.jev)),
      chat: Boolean(config.chat && keyFor(keys, config.chat)),
    };
    for (const slot of ['jev', 'chat'] as const) {
      const profile = config[slot];
      const valid =
        profile &&
        SettingsSchema.safeParse(profile).success &&
        ApiKeySchema.safeParse(keyFor(keys, profile)).success;
      config[`${slot}Enabled`] = Boolean(
        (config[`${slot}Enabled`] ?? keysPresent[slot]) && valid,
      );
    }
    for (const slot of ['jev', 'chat'] as const) {
      if (modelStates[slot]?.phase === 'checking' && !checks.has(slot)) {
        modelStates[slot] = state(
          'failed',
          '上次验证已中断，请重新打开开关验证。',
        );
        config[`${slot}Enabled`] = false;
        await storage.set({ modelStates, routingConfig: config });
      }
    }
    return { config, keys, keysPresent, modelStates };
  }
  function state(phase: ModelState['phase'], message?: string): ModelState {
    return {
      phase,
      updatedAt: new Date().toISOString(),
      ...(message ? { message } : {}),
    };
  }
  return {
    readRoutes: () =>
      exclusive(async () => {
        const { config, keys, keysPresent, modelStates } = await routing();
        const credentials: RouteCredentials = {};
        for (const slot of ['jev', 'chat'] as const) {
          const profile = config[slot];
          if (profile && modelEnabled(config, slot))
            credentials[slot] = {
              settings: {
                ...validateModelSettings(profile),
                reviewThreshold: config.reviewThreshold,
                autoAnswer: config.autoAnswer,
              },
              apiKey: validateApiKey(keyFor(keys, profile)),
            };
        }
        return { config, credentials, keysPresent, modelStates };
      }),
    saveModel: (slot, settings, apiKey) => {
      invalidate(slot);
      return exclusive(async () => {
        const { config, keys, modelStates } = await routing();
        config[slot] = SettingsDraftSchema.parse(settings);
        config[`${slot}Enabled`] = false;
        RoutingDraftSchema.parse(config);
        updateKey(keys, settings, apiKey, false);
        modelStates[slot] = state('idle');
        await storage.set({
          routingConfig: config,
          apiKeys: keys,
          modelStates,
        });
      });
    },
    toggleModel: async (slot, enabled, allowed, verify) => {
      const revision = invalidate(slot);
      if (!enabled)
        return exclusive(async () => {
          const { config, modelStates } = await routing();
          config[`${slot}Enabled`] = false;
          modelStates[slot] = state('disabled');
          await storage.set({ routingConfig: config, modelStates });
        });
      const check = new AbortController();
      checks.set(slot, check);
      const assertCurrent = () => {
        if (check.signal.aborted || revisions[slot] !== revision)
          throw new AppError('CANCELLED', '模型验证已取消。');
      };
      try {
        const credentials = await exclusive(async () => {
          assertCurrent();
          const { config, keys, modelStates } = await routing();
          config[`${slot}Enabled`] = false;
          modelStates[slot] = state('checking');
          await storage.set({ routingConfig: config, modelStates });
          const profile = config[slot];
          if (!profile)
            throw new AppError('SETTINGS', '请先填写模型配置，再打开开关。');
          return {
            settings: validateModelSettings(profile),
            apiKey: validateApiKey(keyFor(keys, profile)),
          };
        });
        assertCurrent();
        if (allowed && !(await allowed(credentials.settings)))
          throw new AppError(
            'API_PERMISSION',
            '未授予模型网站访问权限，请允许访问后重新启用。',
          );
        assertCurrent();
        if (!verify)
          throw new AppError(
            'SETTINGS',
            '模型验证功能不可用，请重新加载扩展。',
          );
        // Network work must never occupy the storage queue: closing stays immediate.
        await verify(credentials, check.signal);
        assertCurrent();
        await exclusive(async () => {
          assertCurrent();
          const { config, modelStates } = await routing();
          assertCurrent();
          config[`${slot}Enabled`] = true;
          modelStates[slot] = state('enabled');
          await storage.set({ routingConfig: config, modelStates });
        });
      } catch (error) {
        await exclusive(async () => {
          if (check.signal.aborted || revisions[slot] !== revision) return;
          const { config, modelStates } = await routing();
          if (check.signal.aborted || revisions[slot] !== revision) return;
          config[`${slot}Enabled`] = false;
          modelStates[slot] = state('failed', publicError(error).message);
          await storage.set({ routingConfig: config, modelStates });
        });
        throw error;
      } finally {
        if (checks.get(slot) === check) checks.delete(slot);
      }
    },
    removeModelKey: (slot) => {
      invalidate(slot);
      return exclusive(async () => {
        const { config, keys, modelStates } = await routing();
        if (config[slot]) updateKey(keys, config[slot], undefined, true);
        config[`${slot}Enabled`] = false;
        modelStates[slot] = state('disabled');
        await storage.set({
          routingConfig: config,
          apiKeys: keys,
          modelStates,
        });
      });
    },
    savePreferences: (reviewThreshold, autoAnswer) =>
      exclusive(async () => {
        const { config } = await routing();
        await storage.set({
          routingConfig: RoutingDraftSchema.parse({
            ...config,
            reviewThreshold,
            autoAnswer,
          }),
        });
      }),
    saveRoutes: (value) => {
      invalidate('jev');
      invalidate('chat');
      return exclusive(async () => {
        const config = RoutingSettingsSchema.parse(value.config),
          { keys } = await load();
        if (config.jev)
          updateKey(keys, config.jev, value.jevApiKey, value.removeJevKey);
        if (config.chat)
          updateKey(keys, config.chat, value.chatApiKey, value.removeChatKey);
        await storage.set({ routingConfig: config, apiKeys: keys });
      });
    },
    read: () =>
      exclusive(async () => {
        const { settings, keys } = await load();
        return {
          settings,
          apiKey:
            settings.provider === 'custom'
              ? (keys.custom?.[keyScope(settings)] ?? '')
              : (keys[settings.provider] ?? ''),
        };
      }),
    save: (value) => {
      invalidate('jev');
      invalidate('chat');
      return exclusive(async () => {
        const settings = SettingsSchema.parse(value.settings);
        const { keys } = await load();
        if (settings.provider === 'custom') {
          const base = keyScope(settings);
          keys.custom ??= {};
          if (value.removeKey) delete keys.custom[base];
          else if (value.apiKey) keys.custom[base] = value.apiKey;
        } else {
          if (value.removeKey) delete keys[settings.provider];
          else if (value.apiKey) keys[settings.provider] = value.apiKey;
        }
        await storage.set({ settings, apiKeys: keys });
      });
    },
  };
}
