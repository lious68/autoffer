import type { Classification } from '../core/classification';
import type { Question, Scan, Suggestion } from '../core/schema';

export interface PlatformContext {
  document: Document;
  url: URL;
}
export interface PlatformAdapter {
  readonly meta: NonNullable<Scan['platform']>;
  matches(context: PlatformContext): boolean;
  extract(context: PlatformContext): Scan;
  /** Optional local question cursor for pages displaying a whole questionnaire. */
  navigation?: {
    list(context: PlatformContext): Array<{ id: string; label: string }>;
    select(context: PlatformContext, id: string): void;
  };
  actions?: PlatformActions;
}
export interface PlatformActions {
  /** A verified next-section control. Must never fall back to a final-submit action. */
  nextSection?(
    context: PlatformContext,
    question: Question,
    signal: AbortSignal,
  ): Promise<'advanced' | 'waiting'>;
  /** Only advertise kinds with verified selection and read-back behavior. */
  readonly answerKinds: readonly ('single' | 'multiple')[];
  assertReady(context: PlatformContext, expected: Question): void;
  apply?(
    context: PlatformContext,
    question: Question,
    suggestion: Suggestion,
    signal: AbortSignal,
    reviewed: boolean,
  ): Promise<'advanced' | 'section-end'>;
  skip?(
    context: PlatformContext,
    question: Question,
    signal: AbortSignal,
  ): Promise<'advanced' | 'section-end'>;
}

export type QuestionRule =
  | ({
      classification: Classification;
      kind?: Question['kind'];
    } & QuestionSelectors)
  | ({
      /** Legacy templates remain readable; new templates should declare classification. */
      kind: Question['kind'];
      classification?: never;
    } & QuestionSelectors);

interface QuestionSelectors {
  /** Scoped within each question block; never read the whole page by default. */
  root: string;
  stem: string;
  material?: string;
  /** Related material outside the question block (e.g. a shared reading passage). */
  sharedMaterial?: string;
  options?: { root: string; text: string; label?: string };
}
export interface PlatformTemplate {
  meta: PlatformAdapter['meta'];
  match: { hosts: readonly string[]; pathPrefix: string; marker: string };
  /** Traverse open shadow roots only inside matched content; never pierce closed roots. */
  readOpenShadowRoots?: boolean;
  rules: readonly QuestionRule[];
}
