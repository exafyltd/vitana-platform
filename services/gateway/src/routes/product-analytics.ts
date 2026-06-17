/**
 * Product Analytics — event ingestion (BOOTSTRAP-PRODUCT-ANALYTICS)
 *
 * Mounted at: /api/v1/analytics
 *
 *   POST /events/batch — accept up to 100 structured product analytics
 *                        events and upsert them into
 *                        product_analytics_events (idempotent on event_id).
 *
 * This is the write side of the supervisor-grade analytics pipeline that
 * backs /admin/insights/* in vitana-v1. It is deliberately separate from
 * oasis_events (audit log) and analytics-celebrate (engagement funnel).
 *
 * Auth: optional — anonymous and authenticated clients both post here, the
 * same model as /celebrate and /rum/beacon. Tenant scoping is carried in
 * each event's tenant_id; reads are gated by requireTenantAdmin on the
 * admin endpoints, never by handing clients table access.
 *
 * Privacy invariants enforced here:
 *   * consent_state='denied' events are dropped before insert.
 *   * properties may not contain raw message text — forbidden keys
 *     (message, prompt, raw_text, transcript, answer) are stripped.
 *   * user_id_hash only; the schema has no raw user id column.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getSupabase } from '../lib/supabase';

const router = Router();
const LOG_PREFIX = '[Analytics:Product]';

export const ANALYTICS_MAX_BATCH = 100;

/**
 * properties keys that could carry raw conversation/health text. Stripped
 * on ingest so a buggy or stale client can never persist message content.
 */
export const FORBIDDEN_PROPERTY_KEYS = [
  'message',
  'prompt',
  'raw_text',
  'transcript',
  'answer',
] as const;

export const analyticsEventSchema = z.object({
  event_id: z.string().min(8).max(128),
  event_name: z.string().min(2).max(96),
  event_type: z.enum([
    'journey',
    'assistant',
    'feature',
    'interest',
    'friction',
    'performance',
    'content',
  ]),
  tenant_id: z.string().uuid(),
  user_id_hash: z.string().max(128).nullable().default(null),
  session_id: z.string().min(4).max(128),
  journey_id: z.string().max(128).nullable().default(null),
  conversation_id: z.string().max(128).nullable().default(null),
  screen_route: z.string().min(1).max(512),
  screen_id: z.string().max(128).nullable().default(null),
  feature_key: z.string().max(128).nullable().default(null),
  source: z.enum(['web', 'ios', 'android', 'gateway', 'assistant', 'orb']),
  app_version: z.string().max(64).nullable().default(null),
  language: z.string().max(16).nullable().default(null),
  device_type: z.enum(['desktop', 'mobile', 'tablet', 'unknown']).default('unknown'),
  consent_state: z.enum(['granted', 'anonymous', 'denied']).default('anonymous'),
  properties: z.record(z.unknown()).default({}),
  occurred_at: z.string().datetime({ offset: true }),
});

export const analyticsBatchSchema = z.object({
  events: z.array(analyticsEventSchema).min(1).max(ANALYTICS_MAX_BATCH),
});

export type ProductAnalyticsEvent = z.infer<typeof analyticsEventSchema>;

export function sanitizeProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if ((FORBIDDEN_PROPERTY_KEYS as readonly string[]).includes(key)) continue;
    clean[key] = value;
  }
  return clean;
}

// Anonymous + authenticated clients both post analytics here (same auth
// model as /celebrate and /rum/beacon); reads are admin-gated.
router.post('/events/batch', async (req: Request, res: Response) => { // public-route
  const parsed = analyticsBatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'INVALID_ANALYTICS_BATCH' });
  }

  const writableEvents = parsed.data.events
    .filter((event) => event.consent_state !== 'denied')
    .map((event) => ({ ...event, properties: sanitizeProperties(event.properties) }));

  const dropped = parsed.data.events.length - writableEvents.length;

  if (writableEvents.length === 0) {
    return res.json({ ok: true, inserted: 0, dropped });
  }

  const supa = getSupabase();
  if (!supa) {
    // Analytics must never block user paths — accept and drop.
    console.warn(`${LOG_PREFIX} supabase not configured; dropping ${writableEvents.length} events`);
    return res.status(202).json({ ok: true, inserted: 0, dropped: parsed.data.events.length });
  }

  const { error } = await supa
    .from('product_analytics_events')
    .upsert(writableEvents, { onConflict: 'event_id', ignoreDuplicates: true });

  if (error) {
    console.error(`${LOG_PREFIX} insert failed: ${error.message}`);
    return res.status(500).json({ ok: false, error: 'ANALYTICS_INSERT_FAILED' });
  }

  // impact-allow-no-oasis — high-volume clickstream is exactly what must NOT
  // enter oasis_events (audit log); this pipeline is its own store.
  return res.json({ ok: true, inserted: writableEvents.length, dropped });
});

export default router;
