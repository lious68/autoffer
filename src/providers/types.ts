import type { Question, Settings, Suggestion } from '../core/schema';
import type { RouteCredentials } from '../core/routing';

export interface ProviderContext {
  apiKey: string;
  settings: Settings;
  signal: AbortSignal;
  routes?: RouteCredentials;
  captureImages?: () => Promise<Array<{ id: string; dataUrl: string }>>;
  images?: Array<{ id: string; dataUrl: string }>;
}
export interface AnswerProvider {
  readonly id: string;
  suggest(question: Question, context: ProviderContext): Promise<Suggestion>;
}
