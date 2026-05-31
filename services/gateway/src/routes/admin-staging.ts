/**
 * Staging-only admin endpoints — VTID-03204 (Phase 1 W2 acceptance helper).
 *
 * One purpose right now: POST /api/v1/admin/staging/tenant-consent/flip —
 * sets tenant_settings.feature_flags.data_export_ok = true on selected
 * staging tenants so the Track C C1 consent gate
 * (services/data-export-consent.ts) starts returning the flag and
 * CRON-DATASET-EXTRACTION can produce real rows.
 *
 * Why this lives here (not in tenant-admin/settings.ts):
 *   - tenant-admin/settings.ts is gated by requireTenantAdmin (per-tenant
 *     admin JWT). We need a single-call bulk path that the autonomous
 *     SET-STAGING-TENANT-CONSENT.yml workflow can hit with the existing
 *     GATEWAY_SERVICE_TOKEN.
 *   - This endpoint is STAGING-ONLY by hard guard — refuses with 403 on
 *     any environment where VITANA_ENV !== 'staging'. There is no path,
 *     even with a valid service token, for it to touch prod tenants.
 *
 * Auth: GATEWAY_SERVICE_TOKEN bearer. Same shape as /api/v1/oasis/emit's
 * service-token path. JWT support intentionally omitted — this is a
 * one-off operator helper, not a user-facing surface.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getSupabase } from '../lib/supabase';
import { isStaging } from '../env';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

const FlipBodySchema = z.object({
  tenant_id: z.string().min(1).max(128).optional(),
  dry_run: z.boolean().optional(),
});

function serviceTokenAuth(req: Request, res: Response, next: () => void): void {
  const header = req.header('authorization') ?? req.header('Authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({ ok: false, error: 'missing bearer token' });
    return;
  }
  const token = header.slice('bearer '.length).trim();
  const expected = process.env.GATEWAY_SERVICE_TOKEN ?? '';
  if (!expected || token !== expected) {
    res.status(401).json({ ok: false, error: 'invalid service token' });
    return;
  }
  next();
}

function stagingOnlyGuard(_req: Request, res: Response, next: () => void): void {
  if (!isStaging) {
    res.status(403).json({
      ok: false,
      error: 'staging_only',
      message: 'This endpoint refuses to run outside VITANA_ENV=staging.',
    });
    return;
  }
  next();
}

router.post(
  '/tenant-consent/flip',
  serviceTokenAuth,
  stagingOnlyGuard,
  async (req: Request, res: Response) => {
    const parsed = FlipBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid_body', issues: parsed.error.issues });
      return;
    }
    const { tenant_id, dry_run } = parsed.data;
    const isDryRun = dry_run !== false; // default true — explicit false to apply

    const supabase = getSupabase();
    if (!supabase) {
      res.status(503).json({ ok: false, error: 'db_unavailable' });
      return;
    }

    let query = supabase
      .from('tenant_settings')
      .select('tenant_id, feature_flags');
    if (tenant_id && tenant_id !== 'ALL') {
      query = query.eq('tenant_id', tenant_id);
    }
    query = query.limit(500);

    const { data: rows, error: readErr } = await query;
    if (readErr) {
      res.status(500).json({ ok: false, error: 'read_failed', message: readErr.message });
      return;
    }

    const all = rows ?? [];
    type Row = { tenant_id: string; feature_flags: Record<string, unknown> | null };
    const already: string[] = [];
    const toFlip: Row[] = [];
    for (const r of all as Row[]) {
      if (r.feature_flags && r.feature_flags.data_export_ok === true) {
        already.push(r.tenant_id);
      } else {
        toFlip.push(r);
      }
    }

    if (isDryRun) {
      res.json({
        ok: true,
        dry_run: true,
        scanned: all.length,
        already_consented: already.length,
        to_flip: toFlip.length,
        sample_to_flip: toFlip.slice(0, 5).map((r) => r.tenant_id),
      });
      return;
    }

    const flipped: string[] = [];
    const failed: Array<{ tenant_id: string; error: string }> = [];
    for (const r of toFlip) {
      const merged = { ...(r.feature_flags ?? {}), data_export_ok: true };
      const { error: updErr } = await supabase
        .from('tenant_settings')
        .update({ feature_flags: merged })
        .eq('tenant_id', r.tenant_id);
      if (updErr) {
        failed.push({ tenant_id: r.tenant_id, error: updErr.message });
      } else {
        flipped.push(r.tenant_id);
      }
    }

    void emitOasisEvent({
      vtid: 'VTID-03204',
      type: 'staging.tenant_consent.flipped',
      source: 'gateway/admin-staging',
      status: failed.length > 0 ? 'warning' : 'success',
      message: `flipped ${flipped.length}/${toFlip.length} staging tenants (${failed.length} failed, ${already.length} already)`,
      payload: {
        env: 'staging',
        scanned: all.length,
        already_consented: already.length,
        flipped_count: flipped.length,
        failed_count: failed.length,
        flipped,
        failed,
      },
    });

    res.json({
      ok: failed.length === 0,
      dry_run: false,
      scanned: all.length,
      already_consented: already.length,
      flipped: flipped.length,
      failed: failed.length,
      flipped_tenant_ids: flipped,
      failed_details: failed,
    });
  },
);

export { router as adminStagingRouter };
