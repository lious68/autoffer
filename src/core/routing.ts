import { solvePolicy } from '../solvers/policy';
import { z } from 'zod';
import {
  SettingsSchema,
  SettingsDraftSchema,
  type Settings,
  type Question,
} from './schema';

export const RoutingSettingsSchema = z
  .object({
    jev: SettingsSchema.nullable(),
    chat: SettingsSchema.nullable(),
    jevEnabled: z.boolean().optional(),
    chatEnabled: z.boolean().optional(),
    reviewThreshold: z.number().min(0.5).max(1).default(0.8),
    autoAnswer: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (
      value.jev &&
      !['typesafe', 'vercel', 'jev-agent'].includes(value.jev.provider)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['jev'],
        message: 'Jev slot requires a Jev provider',
      });
    if (value.chat && !['openrouter', 'custom'].includes(value.chat.provider))
      ctx.addIssue({
        code: 'custom',
        path: ['chat'],
        message: 'Chat slot requires a compatible provider',
      });
  });
export type RoutingSettings = z.infer<typeof RoutingSettingsSchema>;
export type ModelSlot = 'jev' | 'chat';
export function modelEnabled(
  config: RoutingSettings,
  slot: ModelSlot,
): boolean {
  return config[`${slot}Enabled`] ?? Boolean(config[slot]);
}
export const RoutingDraftSchema = RoutingSettingsSchema.safeExtend({
  jev: SettingsDraftSchema.nullable(),
  chat: SettingsDraftSchema.nullable(),
});
export const ModelStateSchema = z.object({
  phase: z.enum(['idle', 'checking', 'enabled', 'disabled', 'failed']),
  message: z.string().max(2000).optional(),
  updatedAt: z.string(),
});
export type ModelState = z.infer<typeof ModelStateSchema>;
export const ModelStatesSchema = z.object({
  jev: ModelStateSchema.optional(),
  chat: ModelStateSchema.optional(),
});
export type ModelStates = z.infer<typeof ModelStatesSchema>;
export const RoutingViewSchema = RoutingDraftSchema.safeExtend({
  hasJevKey: z.boolean(),
  hasChatKey: z.boolean(),
  modelStates: ModelStatesSchema.optional(),
});
export type RoutingView = z.infer<typeof RoutingViewSchema>;
export interface RouteCredential {
  settings: Settings;
  apiKey: string;
}
export interface RouteCredentials {
  jev?: RouteCredential;
  chat?: RouteCredential;
}

export function routeFor(
  question: Question,
  routes: RouteCredentials,
): 'jev' | 'chat' | null {
  const policy = solvePolicy(question);
  if (policy.mode === 'manual') return null;
  const plainObjective = policy.preferredProvider === 'jev';
  if (plainObjective && routes.jev?.apiKey) return 'jev';
  if (routes.chat?.apiKey) return 'chat';
  return null;
}
