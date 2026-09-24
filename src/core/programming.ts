import { z } from 'zod';

export const EditorTicketSchema = z.object({
  token: z.string().min(1).max(100),
  language: z.string().min(1).max(80),
});
export type EditorTicket = z.infer<typeof EditorTicketSchema>;
export const CodeResultSchema = z.object({
  state: z.enum(['filled', 'running', 'passed', 'accepted', 'failed']),
  message: z.string().max(2000),
});
export type CodeResult = z.infer<typeof CodeResultSchema>;
export type CodeCommand =
  | { action: 'prepare'; questionId: string }
  | { action: 'fill'; token: string; code: string }
  | { action: 'run' | 'submit' | 'poll' | 'cancel'; token: string };

export function isAcm(question: {
  id: string;
  isExample?: boolean | undefined;
  classification?: { format: string } | undefined;
}) {
  return (
    question.id.startsWith('nowcoder:acm:') &&
    question.classification?.format === 'programming' &&
    !question.isExample
  );
}
