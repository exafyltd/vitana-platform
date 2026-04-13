/**
 * Intelligent Calendar — Type Definitions
 *
 * The calendar is the 4th pillar of infinite memory, alongside
 * memory_items, memory_diary_entries, and memory_garden_nodes.
 *
 * Role-aware: every event is tagged with a role_context, and queries
 * filter based on the user's active role via ROLE_TO_CONTEXTS.
 */

import { z } from 'zod';

// =============================================================================
// Role Context
// =============================================================================

export type CalendarRoleContext = 'community' | 'admin' | 'developer' | 'personal';

/**
 * Maps an active user role → which role_context values are visible in calendar.
 * Personal events are ALWAYS visible across all roles.
 */
export const ROLE_TO_CONTEXTS: Record<string, CalendarRoleContext[]> = {
  community:   ['community', 'personal'],
  patient:     ['community', 'personal'],
  professional:['community', 'personal'],
  staff:       ['admin', 'personal'],
  admin:       ['admin', 'personal'],
  developer:   ['developer', 'personal'],
  infra:       ['developer', 'personal'],
  // Super admin (exafy_admin=true) → no filter, sees everything
  super_admin: ['community', 'admin', 'developer', 'personal'],
  DEV:         ['developer', 'personal'],
};

/**
 * Resolve which role_context values a role can see.
 * Returns null for super_admin (no filter).
 */
export function getVisibleContexts(role: string | null): CalendarRoleContext[] | null {
  if (!role) return ROLE_TO_CONTEXTS.community;
  if (role === 'super_admin') return null; // no filter
  return ROLE_TO_CONTEXTS[role] ?? ROLE_TO_CONTEXTS.community;
}

// =============================================================================
// Calendar Event (Full Row)
// =============================================================================

export interface CalendarEvent {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string | null;
  location: string | null;
  event_type: string;
  status: string;
  priority: string;
  is_recurring: boolean;
  recurring_pattern: Record<string, unknown> | null;
  attendees_count: number;
  has_rewards: boolean;
  metadata: Record<string, unknown>;
  source_message_id: string | null;
  source_type: string;
  created_at: string;
  updated_at: string;

  // Intelligent Calendar columns
  role_context: CalendarRoleContext;
  source_ref_id: string | null;
  source_ref_type: string | null;
  activated_at: string | null;
  completed_at: string | null;
  completion_status: string | null;
  completion_notes: string | null;
  original_start_time: string | null;
  reschedule_count: number;
  priority_score: number;
  wellness_tags: string[];
}

// =============================================================================
// Calendar Event Summary (for context pack / assistant)
// =============================================================================

export interface CalendarEventSummary {
  id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  event_type: string;
  status: string;
  role_context: string;
  completion_status: string | null;
  priority_score: number;
  wellness_tags: string[];
}

// =============================================================================
// Calendar Context Hit (mirrors MemoryHit for unified pipeline)
// =============================================================================

export interface CalendarContextHit {
  id: string;
  content: string;
  relevance_score: number;
  source: 'calendar';
  domain: string;
  occurred_at: string;
  metadata: {
    event_type: string;
    status: string;
    completion_status: string | null;
    role_context: string;
    wellness_tags: string[];
    is_today: boolean;
    is_upcoming: boolean;
    is_history: boolean;
  };
}

// =============================================================================
// Zod Schemas (API validation)
// =============================================================================

export const CreateCalendarEventSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional().nullable(),
  start_time: z.string().datetime({ message: 'start_time must be ISO 8601' }),
  end_time: z.string().datetime().optional().nullable(),
  location: z.string().optional().nullable(),
  event_type: z.enum([
    'personal', 'community', 'professional', 'health', 'workout', 'nutrition',
    'autopilot', 'journey_milestone', 'dev_task', 'deployment',
    'sprint_milestone', 'admin_task', 'wellness_nudge',
  ]).default('personal'),
  status: z.enum(['confirmed', 'pending', 'conflict', 'cancelled']).default('confirmed'),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  role_context: z.enum(['community', 'admin', 'developer', 'personal']).default('community'),
  source_type: z.enum([
    'manual', 'invite', 'imported',
    'autopilot', 'community_rsvp', 'assistant', 'journey',
    'vtid', 'ci_cd', 'nudge_engine',
  ]).default('manual'),
  source_ref_id: z.string().optional().nullable(),
  source_ref_type: z.string().optional().nullable(),
  priority_score: z.number().int().min(0).max(100).default(50),
  wellness_tags: z.array(z.string()).default([]),
  metadata: z.record(z.any()).optional().default({}),
  is_recurring: z.boolean().default(false),
  recurring_pattern: z.record(z.any()).optional().nullable(),
});

export type CreateCalendarEventInput = z.infer<typeof CreateCalendarEventSchema>;

export const UpdateCalendarEventSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional().nullable(),
  location: z.string().optional().nullable(),
  event_type: z.string().optional(),
  status: z.enum(['confirmed', 'pending', 'conflict', 'cancelled']).optional(),
  priority_score: z.number().int().min(0).max(100).optional(),
  wellness_tags: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
});

export const ListCalendarEventsSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  event_type: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const CompleteEventSchema = z.object({
  completion_status: z.enum(['completed', 'skipped', 'partial']).default('completed'),
  completion_notes: z.string().optional().nullable(),
});

// =============================================================================
// Event type → Domain mapping (for context assembly integration)
// =============================================================================

export const EVENT_TYPE_TO_DOMAIN: Record<string, string> = {
  personal: 'lifestyle',
  community: 'social',
  professional: 'business',
  health: 'health',
  workout: 'health',
  nutrition: 'health',
  autopilot: 'lifestyle',
  journey_milestone: 'lifestyle',
  dev_task: 'business',
  deployment: 'business',
  sprint_milestone: 'business',
  admin_task: 'business',
  wellness_nudge: 'health',
};
