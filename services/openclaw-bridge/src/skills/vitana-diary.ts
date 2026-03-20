/**
 * Vitana Diary Skill for OpenClaw
 *
 * Guided diary templates, free-form journaling,
 * and entity extraction integration for memory enrichment.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const GetTemplatesSchema = z.object({
  tenant_id: z.string().uuid(),
});

const SubmitEntrySchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  template_type: z.enum(['daily_longevity', 'relationships_social', 'habits_routines', 'meaning_values', 'free']),
  content: z.string().min(1).max(10000),
  mood: z.string().max(50).optional(),
  movement_intensity: z.enum(['none', 'light', 'moderate', 'vigorous']).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const ListEntriesSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  template_type: z.enum(['daily_longevity', 'relationships_social', 'habits_routines', 'meaning_values', 'free']).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE required');
  return createClient(url, key);
}

async function callGateway(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<unknown> {
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';
  const res = await fetch(`${gatewayUrl}/api/v1/diary${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Diary endpoint ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Get available diary templates.
   */
  async get_templates(input: unknown) {
    const { tenant_id } = GetTemplatesSchema.parse(input);
    const data = await callGateway(`/templates?tenant_id=${tenant_id}`, 'GET');
    return { success: true, templates: data };
  },

  /**
   * Submit a diary entry (free-form or guided template).
   */
  async submit_entry(input: unknown) {
    const { tenant_id, user_id, template_type, content, mood, movement_intensity, tags, metadata } =
      SubmitEntrySchema.parse(input);

    const data = await callGateway('/entry', 'POST', {
      tenant_id,
      user_id,
      template_type,
      content,
      mood,
      movement_intensity,
      tags,
      metadata,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'diary.entry_submitted',
      actor: 'openclaw-autopilot',
      details: { user_id, template_type, content_length: content.length },
      created_at: new Date().toISOString(),
    });

    return { success: true, entry: data };
  },

  /**
   * List diary entries for a user with optional template filter.
   */
  async list_entries(input: unknown) {
    const { tenant_id, user_id, template_type, limit } = ListEntriesSchema.parse(input);
    const supabase = getSupabase();

    let query = supabase
      .from('memory_items')
      .select('id, template_type, content, mood, tags, created_at')
      .eq('tenant_id', tenant_id)
      .eq('user_id', user_id)
      .eq('source', 'diary')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (template_type) query = query.eq('template_type', template_type);

    const { data, error } = await query;
    if (error) throw new Error(`list_entries failed: ${error.message}`);
    return { success: true, entries: data, count: data?.length ?? 0 };
  },
};

export const SKILL_META = {
  name: 'vitana-diary',
  description: 'Guided diary templates, free-form journaling, and memory-enriched entries',
  actions: Object.keys(actions),
};
