/**
 * orb-tools/awareness-tools.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb-tools/awareness-tools.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param) — tools receive their client per-call, not a module-level
 * singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== reminders ====================

export async function fetchLatestReminderTimezone(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb
    .from('reminders')
    .select('user_tz')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1);
}

export async function fetchRemindersDueSoon(sb: SupabaseClient, userId: string, tenantId: string, beforeIso: string) {
  return sb
    .from('reminders')
    .select('action_text, next_fire_at')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .lte('next_fire_at', beforeIso)
    .order('next_fire_at', { ascending: true })
    .limit(5);
}

// ==================== calendar_events ====================

export async function fetchCalendarWindowEvents(sb: SupabaseClient, userId: string, fromIso: string, toIso: string) {
  return sb
    .from('calendar_events')
    .select('id, title, start_time, end_time, event_type')
    .eq('user_id', userId)
    .eq('status', 'scheduled')
    .gte('start_time', fromIso)
    .lte('start_time', toIso)
    .order('start_time', { ascending: true })
    .limit(20);
}

// ==================== emotional_cognitive_signals ====================

export async function fetchLatestEmotionalCognitiveSignal(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('emotional_cognitive_signals')
    .select(
      'emotional_states, cognitive_states, engagement_level, engagement_confidence, ' +
        'urgency_detected, hesitation_detected, created_at, decay_at',
    )
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('decayed', false)
    .order('created_at', { ascending: false })
    .limit(1);
}

// ==================== memory_diary_entries ====================

export async function fetchRecentDiaryMoods(sb: SupabaseClient, tenantId: string, userId: string, sinceDate: string) {
  return sb
    .from('memory_diary_entries')
    .select('mood, energy_level, entry_date')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .gte('entry_date', sinceDate)
    .order('entry_date', { ascending: false })
    .limit(5);
}

// ==================== memory_facts ====================

export async function fetchLatestActiveFactValue(sb: SupabaseClient, tenantId: string, userId: string, factKey: string) {
  return sb
    .from('memory_facts')
    .select('fact_value')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('fact_key', factKey)
    .eq('entity', 'self')
    .is('superseded_by', null)
    .order('extracted_at', { ascending: false })
    .limit(1);
}

// ==================== life_stage_assessments ====================

export async function fetchLatestValidLifeStageAssessment(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('life_stage_assessments')
    .select('phase, phase_confidence, stability_level, transition_flag, transition_type')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('valid', true)
    .order('created_at', { ascending: false })
    .limit(1);
}

// ==================== life_stage_goals ====================

export async function fetchActiveLifeStageGoals(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('life_stage_goals')
    .select('category, description, priority')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('priority', { ascending: false })
    .limit(3);
}

// ==================== life_compass ====================

export async function fetchActiveLifeCompass(sb: SupabaseClient, userId: string) {
  return sb
    .from('life_compass')
    .select('primary_goal, category')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);
}

// ==================== app_users ====================

export async function fetchAppUserCreatedAt(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('created_at').eq('user_id', userId).limit(1);
}
