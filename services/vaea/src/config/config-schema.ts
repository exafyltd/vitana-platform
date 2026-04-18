import { z } from 'zod';

export const autonomyModeSchema = z.enum([
  'silent',
  'draft_to_user',
  'one_tap_approve',
  'auto_post',
]);
export type AutonomyMode = z.infer<typeof autonomyModeSchema>;

export const vaeaConfigSchema = z.object({
  user_id: z.string().uuid(),
  tenant_id: z.string().uuid(),

  receive_recommendations: z.boolean().default(true),
  give_recommendations: z.boolean().default(false),
  make_money_goal: z.boolean().default(false),

  autonomy_default: autonomyModeSchema.default('draft_to_user'),
  autonomy_by_channel: z.record(z.string(), autonomyModeSchema).default({}),

  expertise_zones: z.array(z.string()).default([]),
  excluded_categories: z.array(z.string()).default([]),
  blocked_counterparties: z.array(z.string()).default([]),

  voice_samples: z.array(z.string()).default([]),
  disclosure_text: z.string().default(
    'I earn a small commission if you use this link — happy to share non-affiliate alternatives too.'
  ),

  max_replies_per_day: z.number().int().min(0).default(0),
  min_minutes_between_replies: z.number().int().min(0).default(30),

  mesh_scope: z.enum(['maxina_only', 'open']).default('maxina_only'),

  updated_at: z.string().datetime().optional(),
});

export type VaeaConfig = z.infer<typeof vaeaConfigSchema>;

export const referralCatalogItemSchema = z.object({
  id: z.string().uuid().optional(),
  user_id: z.string().uuid(),
  tenant_id: z.string().uuid(),

  tier: z.enum(['own', 'vetted_partner', 'affiliate_network']),
  category: z.string(),
  title: z.string(),
  description: z.string().optional(),
  affiliate_url: z.string().url(),
  affiliate_network: z.string().optional(),
  commission_percent: z.number().min(0).max(100).optional(),

  personal_note: z.string().optional(),
  vetting_status: z.enum(['unvetted', 'tried', 'endorsed']).default('unvetted'),
  active: z.boolean().default(true),
});

export type ReferralCatalogItem = z.infer<typeof referralCatalogItemSchema>;
