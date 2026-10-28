/**
 * Vitana Marketplace Skill for OpenClaw
 *
 * Services and products catalog management, user offers,
 * recommendations, usage outcomes, and trust scoring.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const AddServiceSchema = z.object({
  tenant_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  type: z.enum(['coach', 'doctor', 'lab', 'wellness', 'nutrition', 'fitness', 'therapy', 'other']),
  description: z.string().max(2000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const AddProductSchema = z.object({
  tenant_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  type: z.enum(['supplement', 'device', 'food', 'wearable', 'app', 'other']),
  description: z.string().max(2000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const SetOfferStateSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  offer_id: z.string().uuid(),
  state: z.enum(['viewed', 'saved', 'used', 'dismissed', 'rated']),
  rating: z.number().min(1).max(5).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const RecordOutcomeSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  offer_id: z.string().uuid(),
  outcome_type: z.enum(['sleep', 'stress', 'movement', 'nutrition', 'social', 'energy', 'other']),
  perceived_impact: z.number().min(-5).max(5),
  notes: z.string().max(2000).optional(),
});

const GetRecommendationsSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  limit: z.number().int().min(1).max(50).default(10),
});

const GetMemorySchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
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
  const res = await fetch(`${gatewayUrl}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Marketplace endpoint ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Add a service to the catalog.
   */
  async add_service(input: unknown) {
    const { tenant_id, name, type, description, metadata } = AddServiceSchema.parse(input);

    const data = await callGateway('/catalog/services', 'POST', {
      tenant_id,
      name,
      type,
      description,
      metadata,
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'marketplace.service_added',
      actor: 'openclaw-autopilot',
      details: { name, type },
      created_at: new Date().toISOString(),
    });

    return { success: true, service: data };
  },

  /**
   * Add a product to the catalog.
   */
  async add_product(input: unknown) {
    const { tenant_id, name, type, description, metadata } = AddProductSchema.parse(input);

    const data = await callGateway('/catalog/products', 'POST', {
      tenant_id,
      name,
      type,
      description,
      metadata,
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'marketplace.product_added',
      actor: 'openclaw-autopilot',
      details: { name, type },
      created_at: new Date().toISOString(),
    });

    return { success: true, product: data };
  },

  /**
   * Set user interaction state for an offer (viewed, saved, used, dismissed, rated).
   */
  async set_offer_state(input: unknown) {
    const { tenant_id, user_id, offer_id, state, rating, metadata } =
      SetOfferStateSchema.parse(input);

    const data = await callGateway('/offers/state', 'POST', {
      tenant_id,
      user_id,
      offer_id,
      state,
      rating,
      metadata,
    });

    return { success: true, result: data };
  },

  /**
   * Record a usage outcome for an offer.
   */
  async record_outcome(input: unknown) {
    const { tenant_id, user_id, offer_id, outcome_type, perceived_impact, notes } =
      RecordOutcomeSchema.parse(input);

    const data = await callGateway('/offers/outcome', 'POST', {
      tenant_id,
      user_id,
      offer_id,
      outcome_type,
      perceived_impact,
      notes,
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'marketplace.outcome_recorded',
      actor: 'openclaw-autopilot',
      details: { user_id, offer_id, outcome_type, perceived_impact },
      created_at: new Date().toISOString(),
    });

    return { success: true, outcome: data };
  },

  /**
   * Get personalized offer recommendations for a user.
   */
  async get_recommendations(input: unknown) {
    const { tenant_id, user_id, limit } = GetRecommendationsSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('user_id', user_id);
    params.set('limit', String(limit));

    const data = await callGateway(`/offers/recommendations?${params.toString()}`, 'GET');
    return { success: true, recommendations: data };
  },

  /**
   * Get user's offer interaction memory.
   */
  async get_memory(input: unknown) {
    const { tenant_id, user_id, limit } = GetMemorySchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('user_id', user_id);
    params.set('limit', String(limit));

    const data = await callGateway(`/offers/memory?${params.toString()}`, 'GET');
    return { success: true, memory: data };
  },
};

export const SKILL_META = {
  name: 'vitana-marketplace',
  description: 'Services and products catalog, offer recommendations, usage outcomes, and trust scoring',
  actions: Object.keys(actions),
};
