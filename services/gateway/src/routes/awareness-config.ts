/**
 * Awareness Config admin API — BOOTSTRAP-AWARENESS-REGISTRY
 *
 * GET  /api/v1/awareness/config         → manifest + overrides + resolved
 * GET  /api/v1/awareness/audit          → last N changes
 * POST /api/v1/awareness/config         → upsert one signal
 * POST /api/v1/awareness/config/bulk    → upsert many in one call (for the
 *                                          admin page Save button)
 *
 * All endpoints require exafy_admin via the requireAdminAuth middleware.
 * Writes use service-role to bypass RLS and append a row to
 * awareness_config_audit.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { requireAdminAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import {
  getAwarenessConfig,
  invalidateAwarenessConfigCache,
  getManifest,
  getSignal,
} from '../services/awareness-registry';

const router = Router();

function adminClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

// =============================================================================
// GET /api/v1/awareness/config
// =============================================================================
router.get('/config', requireAdminAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const snap = await getAwarenessConfig();
    return res.status(200).json({
      ok: true,
      manifest: getManifest(),
      overrides: snap.overrides,
      resolved: snap.resolved,
      built_at: snap.built_at,
    });
  } catch (err: any) {
    console.error('[awareness-config] GET failed:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message || 'unknown' });
  }
});

// =============================================================================
// GET /api/v1/awareness/audit?limit=20
// =============================================================================
router.get('/audit', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const client = adminClient();
  if (!client) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10), 1), 100);

  const { data, error } = await client
    .from('awareness_config_audit')
    .select('id, key, prev_enabled, new_enabled, prev_params, new_params, changed_by, changed_at')
    .order('changed_at', { ascending: false })
    .limit(limit);

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
  return res.status(200).json({ ok: true, entries: data || [] });
});

// =============================================================================
// POST /api/v1/awareness/config — upsert ONE
// =============================================================================
const SingleChangeSchema = z.object({
  key: z.string().min(1),
  enabled: z.boolean(),
  params: z.record(z.unknown()).optional(),
});

router.post('/config', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = SingleChangeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Invalid body', details: parsed.error.errors });
  }
  const { key, enabled, params } = parsed.data;

  const sig = getSignal(key);
  if (!sig) {
    return res.status(404).json({ ok: false, error: `Unknown awareness signal: ${key}` });
  }
  if (sig.locked && !enabled) {
    return res.status(400).json({
      ok: false,
      error: `Signal ${key} is locked and cannot be disabled`,
    });
  }

  const result = await upsertOne(key, enabled, params || {}, req.identity!.user_id);
  if (!result.ok) return res.status(500).json({ ok: false, error: result.error });

  invalidateAwarenessConfigCache();
  return res.status(200).json({ ok: true, key, enabled, params: result.new_params });
});

// =============================================================================
// POST /api/v1/awareness/config/bulk — upsert many
// =============================================================================
const BulkBodySchema = z.object({
  changes: z.array(SingleChangeSchema).min(1).max(500),
});

router.post('/config/bulk', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = BulkBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Invalid body', details: parsed.error.errors });
  }

  const userId = req.identity!.user_id;
  const failures: { key: string; error: string }[] = [];
  const succeeded: { key: string; enabled: boolean }[] = [];

  for (const change of parsed.data.changes) {
    const sig = getSignal(change.key);
    if (!sig) {
      failures.push({ key: change.key, error: 'unknown signal' });
      continue;
    }
    if (sig.locked && !change.enabled) {
      failures.push({ key: change.key, error: 'locked — cannot disable' });
      continue;
    }
    const r = await upsertOne(change.key, change.enabled, change.params || {}, userId);
    if (r.ok) succeeded.push({ key: change.key, enabled: change.enabled });
    else failures.push({ key: change.key, error: r.error || 'unknown' });
  }

  invalidateAwarenessConfigCache();
  return res.status(200).json({
    ok: failures.length === 0,
    succeeded,
    failures,
  });
});

// =============================================================================
// Helper: upsert a single key + write audit row
// =============================================================================
async function upsertOne(
  key: string,
  enabled: boolean,
  params: Record<string, unknown>,
  changedBy: string
): Promise<{ ok: true; new_params: Record<string, unknown> } | { ok: false; error: string }> {
  const client = adminClient();
  if (!client) return { ok: false, error: 'Supabase not configured' };

  // Read previous state for audit.
  const { data: prevRow } = await client
    .from('awareness_config')
    .select('enabled, params')
    .eq('key', key)
    .maybeSingle();
  const prevEnabled = prevRow?.enabled ?? null;
  const prevParams = (prevRow?.params as Record<string, unknown>) ?? null;

  const { error: upsertError } = await client
    .from('awareness_config')
    .upsert(
      {
        key,
        enabled,
        params,
        updated_by: changedBy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' }
    );
  if (upsertError) return { ok: false, error: upsertError.message };

  // Audit row — best effort; don't fail the write if audit fails.
  await client
    .from('awareness_config_audit')
    .insert({
      key,
      prev_enabled: prevEnabled,
      new_enabled: enabled,
      prev_params: prevParams,
      new_params: params,
      changed_by: changedBy,
    })
    .then(({ error }) => {
      if (error) console.warn(`[awareness-config] audit insert failed: ${error.message}`);
    });

  return { ok: true, new_params: params };
}

export default router;
