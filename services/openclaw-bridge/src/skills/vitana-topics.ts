/**
 * Vitana Topics Skill for OpenClaw
 *
 * Interest topic registry, user topic profiles,
 * topic validation, and topic-based filtering.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TOPIC_CATEGORIES = [
  'health', 'community', 'lifestyle', 'nutrition',
  'sleep', 'movement', 'mindset', 'medical', 'longevity',
] as const;

const GetProfileSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

const RecomputeProfileSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

const CreateTopicSchema = z.object({
  tenant_id: z.string().uuid(),
  topic_key: z.string().min(1).max(100),
  label: z.string().min(1).max(255),
  category: z.enum(TOPIC_CATEGORIES),
  safety_level: z.enum(['safe', 'sensitive']).default('safe'),
  metadata: z.record(z.unknown()).optional(),
});

const ListTopicsSchema = z.object({
  tenant_id: z.string().uuid(),
  category: z.enum(TOPIC_CATEGORIES).optional(),
});

const ValidateTopicsSchema = z.object({
  tenant_id: z.string().uuid(),
  topic_keys: z.array(z.string().max(100)).min(1).max(50),
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
  const res = await fetch(`${gatewayUrl}/api/v1/topics${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Topics endpoint ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Get a user's topic profile (interest scores).
   */
  async get_profile(input: unknown) {
    const { tenant_id, user_id } = GetProfileSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('user_id', user_id);

    const data = await callGateway(`/profile?${params.toString()}`, 'GET');
    return { success: true, profile: data };
  },

  /**
   * Recompute a user's topic profile from their activity.
   */
  async recompute_profile(input: unknown) {
    const { tenant_id, user_id } = RecomputeProfileSchema.parse(input);

    const data = await callGateway('/recompute', 'POST', {
      tenant_id,
      user_id,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'topics.profile_recomputed',
      actor: 'openclaw-autopilot',
      details: { user_id },
      created_at: new Date().toISOString(),
    });

    return { success: true, result: data };
  },

  /**
   * Create a new topic in the registry.
   */
  async create_topic(input: unknown) {
    const { tenant_id, topic_key, label, category, safety_level, metadata } =
      CreateTopicSchema.parse(input);

    const data = await callGateway('/registry', 'POST', {
      tenant_id,
      topic_key,
      label,
      category,
      safety_level,
      metadata,
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'topics.topic_created',
      actor: 'openclaw-autopilot',
      details: { topic_key, label, category },
      created_at: new Date().toISOString(),
    });

    return { success: true, topic: data };
  },

  /**
   * List all topics from the registry with optional category filter.
   */
  async list_topics(input: unknown) {
    const { tenant_id, category } = ListTopicsSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    if (category) params.set('category', category);

    const data = await callGateway(`/registry?${params.toString()}`, 'GET');
    return { success: true, topics: data };
  },

  /**
   * Validate topic keys against the registry.
   */
  async validate(input: unknown) {
    const { tenant_id, topic_keys } = ValidateTopicsSchema.parse(input);

    const data = await callGateway('/validate', 'POST', {
      tenant_id,
      topic_keys,
    });

    return { success: true, validation: data };
  },
};

export const SKILL_META = {
  name: 'vitana-topics',
  description: 'Interest topic registry, user topic profiles, validation, and category management',
  actions: Object.keys(actions),
};
