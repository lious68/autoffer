import { z } from 'zod';

/** Independent axes: where a question belongs, how it is answered, and what it asks. */
export const ClassificationSchema = z.object({
  domain: z.enum(['unknown', 'professional', 'aptitude', 'psychological']),
  format: z.enum([
    'single-choice',
    'multiple-choice',
    'true-false',
    'fill-blank',
    'subjective',
    'programming',
    'scale',
    'ranking',
    'unknown',
  ]),
  intent: z.enum(['knowledge', 'self-report', 'unknown']),
  subject: z.string().min(1).max(100).optional(),
});
export type Classification = z.infer<typeof ClassificationSchema>;
export type InteractionKind = 'single' | 'multiple' | 'text' | 'personal';
type Classified = {
  kind: InteractionKind;
  classification?: Classification | undefined;
};

/** Compatibility projection for the existing provider and interaction protocols. */
export function interactionKind(value: Classification): InteractionKind {
  if (value.intent === 'self-report') return 'personal';
  if (['single-choice', 'true-false'].includes(value.format)) return 'single';
  if (value.format === 'multiple-choice') return 'multiple';
  return 'text';
}

export function classificationOf(question: Classified): Classification {
  return (
    question.classification ?? {
      domain: 'unknown',
      format: {
        single: 'single-choice',
        multiple: 'multiple-choice',
        text: 'subjective',
        personal: 'unknown',
      }[question.kind] as Classification['format'],
      intent: question.kind === 'personal' ? 'self-report' : 'knowledge',
    }
  );
}

export function classificationIssue(question: Classified): string | null {
  const value = classificationOf(question);
  if (question.classification && interactionKind(value) !== question.kind)
    return '题目分类与交互类型不一致，请检查平台模板。';
  if (value.intent === 'self-report')
    return '个人倾向题需要你根据真实情况作答。';
  if (value.intent === 'unknown') return '题目作答意图尚未确认，请手动作答。';
  if (['scale', 'ranking', 'unknown'].includes(value.format))
    return '此题目形式尚未适配求解与答案校验，请手动作答。';
  return null;
}
