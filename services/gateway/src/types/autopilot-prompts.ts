/**
 * Autopilot Prompts Types - VTID-01089 Autopilot Matchmaking Prompts
 * Type definitions for autopilot prompt preferences, generation, and actions
 */

import { z } from 'zod';

// ==================== Match Types ====================
export const MatchType = z.enum(['person', 'group', 'event', 'service', 'product', 'location']);
export type MatchType = z.infer<typeof MatchType>;

// ==================== Prompt State ====================
export const PromptState = z.enum(['shown', 'accepted', 'dismissed', 'expired']);
export type PromptState = z.infer<typeof PromptState>;

// ==================== Prompt Actions ====================
export const PromptActionKey = z.enum(['yes', 'not_now', 'options']);
export type PromptActionKey = z.infer<typeof PromptActionKey>;

// ==================== Quiet Hours ====================
export const QuietHoursSchema = z.object({
  from: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)'),
  to: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)'),
}).nullable();

export type QuietHours = z.infer<typeof QuietHoursSchema>;

// ==================== Prompt Preferences ====================
export const PromptPrefsSchema = z.object({
  enabled: z.boolean().default(true),
  max_prompts_per_day: z.number().int().min(0).max(50).default(5),
  quiet_hours: QuietHoursSchema.optional().nullable(),
  allow_types: z.array(MatchType).default(['person', 'group', 'event', 'service']),
});

export type PromptPrefs = z.infer<typeof PromptPrefsSchema>;

// ==================== Update Prefs Request ====================
export const UpdatePrefsRequestSchema = z.object({
  enabled: z.boolean().optional(),
  max_prompts_per_day: z.number().int().min(0).max(50).optional(),
  quiet_hours: QuietHoursSchema.optional(),
  allow_types: z.array(MatchType).optional(),
});

export type UpdatePrefsRequest = z.infer<typeof UpdatePrefsRequestSchema>;

// ==================== Prefs Response ====================
export interface PromptPrefsResponse {
  ok: boolean;
  prefs?: {
    id: string | null;
    enabled: boolean;
    max_prompts_per_day: number;
    quiet_hours: QuietHours | null;
    allow_types: MatchType[];
    prompts_today: number;
    in_quiet_hours: boolean;
  };
  error?: string;
}

// ==================== Prompt Action ====================
export interface PromptAction {
  key: PromptActionKey;
  label?: string;
}

// ==================== Prompt ====================
export interface AutopilotPrompt {
  id: string;
  tenant_id: string;
  user_id: string;
  prompt_date: string;
  prompt_type: 'match_suggestion' | 'recommendation' | 'reminder';
  match_id: string | null;
  match_type: MatchType | null;
  title: string;
  message: string;
  actions: PromptAction[];
  state: PromptState;
  action_taken: PromptActionKey | null;
  target_id: string | null;
  target_type: MatchType | null;
  target_title: string | null;
  topic: string | null;
  created_at: string;
  shown_at: string | null;
  actioned_at: string | null;
}

// ==================== Generate Prompts Request ====================
export const GeneratePromptsRequestSchema = z.object({
  // Optional: override default threshold for match score
  score_threshold: z.number().min(0).max(100).default(75),
  // Optional: limit number of prompts to generate
  limit: z.number().int().min(1).max(10).default(5),
});

export type GeneratePromptsRequest = z.infer<typeof GeneratePromptsRequestSchema>;

// ==================== Generate Prompts Response ====================
export interface GeneratePromptsResponse {
  ok: boolean;
  generated: number;
  prompts?: AutopilotPrompt[];
  error?: string;
  rate_limit_info?: {
    max_per_day: number;
    used_today: number;
    remaining: number;
  };
}

// ==================== Today's Prompts Response ====================
export interface TodayPromptsResponse {
  ok: boolean;
  prompts: AutopilotPrompt[];
  rate_limit_info: {
    max_per_day: number;
    used_today: number;
    remaining: number;
    in_quiet_hours: boolean;
  };
  error?: string;
}

// ==================== Prompt Action Request ====================
export const PromptActionRequestSchema = z.object({
  action: PromptActionKey,
});

export type PromptActionRequest = z.infer<typeof PromptActionRequestSchema>;

// ==================== Prompt Action Response ====================
export interface PromptActionResponse {
  ok: boolean;
  prompt_id: string;
  action: PromptActionKey;
  new_state: PromptState;
  // For 'yes' action: result of the executed action
  action_result?: {
    type: 'connection_request' | 'group_join' | 'event_rsvp' | 'interest_saved';
    target_id: string;
    target_type: MatchType;
    success: boolean;
    message?: string;
  };
  // For 'options' action: list of top candidates
  options?: Array<{
    id: string;
    type: MatchType;
    title: string;
    score: number;
    topic: string;
  }>;
  error?: string;
}

// ==================== Match Daily (from VTID-01088) ====================
// Reference type for matches_daily table - actual implementation in VTID-01088
export interface MatchDaily {
  id: string;
  tenant_id: string;
  user_id: string;
  match_date: string;
  match_type: MatchType;
  target_id: string;
  target_title: string;
  score: number;
  topic: string;
  state: 'suggested' | 'accepted' | 'dismissed' | 'expired';
  created_at: string;
}

// ==================== OASIS Event Payloads ====================
export interface AutopilotPromptEventPayload {
  vtid: string;
  tenant_id: string;
  user_id: string;
  prompt_id?: string;
  match_id?: string;
  match_type?: MatchType;
  action?: PromptActionKey;
  count?: number;
}

// ==================== OASIS Event Types ====================
export const AUTOPILOT_PROMPT_EVENT_TYPES = [
  'autopilot.prompts.generated',
  'autopilot.prompt.shown',
  'autopilot.prompt.action.accepted',
  'autopilot.prompt.action.dismissed',
  'autopilot.prompt.action.options_opened',
  'autopilot.prefs.updated',
] as const;

export type AutopilotPromptEventType = typeof AUTOPILOT_PROMPT_EVENT_TYPES[number];
