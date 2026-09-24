import { z } from 'zod';

export const ToolStateSchema = z.object({
  mounted: z.boolean(),
  started: z.boolean(),
  running: z.boolean(),
  ended: z.boolean(),
  hidden: z.boolean(),
  atEnd: z.boolean(),
  reportDownloadPending: z.boolean().optional(),
});
export type ToolState = z.infer<typeof ToolStateSchema>;
export const idleToolState: ToolState = {
  mounted: false,
  started: false,
  running: false,
  ended: false,
  hidden: false,
  atEnd: false,
};
