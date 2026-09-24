import type { Settings } from './schema';

export const astraFlow = {
  label: 'AstraFlow',
  baseUrl: 'https://api.modelverse.cn/v1',
  model: 'deepseek-v4.1-flash',
} as const;

export const connections = {
  'jev-agent': {
    label: 'Jev Agent（第三方）',
    endpoint: 'https://jev-agent.com/api/v1/systemone',
    defaultModel: 'jev-latest',
    keyUrl: 'https://jev-agent.com/api-access',
  },
  openrouter: {
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: '',
    keyUrl: 'https://openrouter.ai/settings/keys',
  },
  custom: {
    label: astraFlow.label,
    endpoint: '',
    defaultModel: astraFlow.model,
    keyUrl: '',
  },
  vercel: {
    label: 'Vercel AI Gateway',
    endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
    defaultModel: 'typesafe-ai/jev',
    keyUrl:
      'https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys',
  },
  typesafe: {
    label: 'TypeSafe 官方',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    defaultModel: 'jev-latest',
    keyUrl: 'https://console.typesafe.ai/',
  },
} as const;
export const modelPresets: Record<'jev' | 'chat', Settings> = {
  jev: { provider: 'typesafe', model: 'jev-latest', reviewThreshold: 0.8 },
  chat: {
    provider: 'custom',
    baseUrl: astraFlow.baseUrl,
    model: astraFlow.model,
    reviewThreshold: 0.8,
    vision: false,
  },
};
export type ConnectionId = keyof typeof connections;

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Base URL must be an HTTPS URL without credentials, query or fragment',
    );
  if (
    url.pathname.endsWith('/chat/completions') ||
    url.pathname.endsWith('/chat/completions/')
  )
    throw new Error('Use the base URL, not the chat/completions endpoint');
  return url.href.replace(/\/+$/, '');
}

export function connectionFor(settings: Settings) {
  const connection = connections[settings.provider];
  return settings.provider === 'custom'
    ? {
        ...connection,
        endpoint: `${normalizeBaseUrl(settings.baseUrl ?? '')}/chat/completions`,
      }
    : connection;
}

export function connectionOrigin(settings: Settings) {
  return new URL(connectionFor(settings).endpoint).origin + '/*';
}
