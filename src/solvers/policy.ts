import {
  classificationOf,
  classificationIssue,
  type Classification,
} from '../core/classification';
import type { Question } from '../core/schema';

// Static, reviewable instructions shared by providers. No DOM, network or credentials.
const domainInstructions: Record<Classification['domain'], string> = {
  unknown:
    'Use only the supplied question and relevant knowledge; do not assume a missing assessment domain.',
  professional:
    'Respect the stated technical domain, terminology and constraints. Do not invent unspecified versions or prerequisites.',
  aptitude:
    'Check units, numerical relationships, logical quantifiers and the supplied passage before choosing an answer.',
  psychological:
    "Answer psychology knowledge questions using the supplied context. Do not infer the candidate's personality or personal experiences.",
};

export function solvePolicy(question: Question) {
  const classification = classificationOf(question);
  const issue = question.isExample
    ? '输入输出例题不计分，不调用模型。'
    : classificationIssue(question);
  const reference = ['fill-blank', 'subjective', 'programming'].includes(
    classification.format,
  );
  return {
    classification,
    mode: issue
      ? ('manual' as const)
      : reference
        ? ('reference' as const)
        : ('choice' as const),
    preferredProvider: issue
      ? null
      : reference || question.hasVisual
        ? ('chat' as const)
        : ('jev' as const),
    instructions: [
      domainInstructions[classification.domain],
      classification.format === 'true-false'
        ? 'Map the judgement to the actual option IDs; never assume that the first option means true.'
        : '',
      classification.format === 'fill-blank'
        ? 'Identify each blank in order and provide its value in answerText.'
        : '',
      classification.format === 'programming'
        ? 'Provide reference code respecting the stated language and input/output constraints.'
        : '',
    ]
      .filter(Boolean)
      .join(' '),
  };
}
