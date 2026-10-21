/**
 * VTID-02865: Voice Improve cockpit endpoints.
 *
 *   GET  /api/v1/voice/improvement/briefing      ranked action queue + quality score
 *   POST /api/v1/voice/improvement/items/:id/create-vtid    idempotent VTID allocator
 *
 * Auth posture (explicit, not mount-level only):
 *   - GET  → requireDevAccess (exafy_admin OR X-Gateway-Internal). The
 *     briefing exposes operational health, source files, and recommendation
 *     prose; must not leak to anonymous callers if a future mount changes.
 *   - POST → stricter: requireAuthWithTenant + req.identity.exafy_admin.
 *     Mutations to the ledger get the higher bar.
 *
 * The POST is idempotent on `id` (the action item id from the briefing). It
 * checks vtid_ledger for a row with metadata.source_action_item_id === id;
 * if found, returns that VTID instead of allocating a new one. Mirrors the
 * invariants of POST /voice-lab/healing/reports/:id/execute.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  requireAuth,
  requireAuthWithTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { buildVoiceImprovementBriefing } from '../services/voice-improvement-aggregator';
// VTID-02867: per-provider quality rollup feeds the Providers & Voice quality strip.
import { getProviderQualityRollup } from '../services/voice-quality-by-provider';

const router = Router();
const VTID = 'VTID-02865';

// ---------------------------------------------------------------------------
// Local auth helper — mirrors dev-autopilot.ts requireDevRole. We don't import
// from dev-autopilot.ts to avoid coupling routers; the logic is small and
// deliberately duplicated.
// ---------------------------------------------------------------------------
async function requireDevAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (
    req.get('X-Gateway-Internal') === (process.env.GATEWAY_INTERNAL_TOKEN || '__dev__') &&
    process.env.GATEWAY_INTERNAL_TOKEN
  ) {
    return next();
  }
  let authFailed = false;
  await requireAuth(req as AuthenticatedRequest, res, () => {
    const identity = (req as AuthenticatedRequest).identity;
    if (!identity) {
      authFailed = true;
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', vtid: VTID });
      return;
    }
    if (identity.exafy_admin === true) return next();
    authFailed = true;
    res.status(403).json({
      ok: false,
      error: 'Voice Improve requires developer access (exafy_admin)',
      vtid: VTID,
    });
  });
  if (authFailed) return;
}

function getSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return { url, key };
}

// ---------------------------------------------------------------------------
// GET /api/v1/voice/improvement/briefing
// ---------------------------------------------------------------------------
router.get('/voice/improvement/briefing', requireDevAccess, async (req: Request, res: Response) => {
  try {
    const max = req.query.max ? parseInt(String(req.query.max), 10) : undefined;
    const briefing = await buildVoiceImprovementBriefing({ max });
    if ('error' in briefing) {
      return res.status(500).json({ ok: false, error: briefing.error, vtid: VTID });
    }
    res.json({ ok: true, ...briefing, vtid: VTID });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message, vtid: VTID });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/voice/improvement/items/:id/create-vtid
// Idempotent — keyed by metadata.source_action_item_id.
// ---------------------------------------------------------------------------
router.post(
  '/voice/improvement/items/:id/create-vtid',
  requireAuthWithTenant,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.identity?.exafy_admin) {
      return res.status(403).json({
        ok: false,
        error: 'exafy_admin role required to create VTIDs from improvement items',
        vtid: VTID,
      });
    }
    const cfg = getSupabaseConfig();
    if (!cfg) {
      return res.status(500).json({ ok: false, error: 'supabase not configured', vtid: VTID });
    }

    const itemId = req.params.id;
    if (!itemId || itemId.length > 256) {
      return res.status(400).json({ ok: false, error: 'invalid item id', vtid: VTID });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title.slice(0, 200) : `IMPROVE: ${itemId.slice(0, 180)}`;
    const summary = typeof body.summary === 'string' ? body.summary.slice(0, 2000) : itemId;
    const sourceFiles = Array.isArray(body.source_files) ? (body.source_files as string[]).slice(0, 20) : [];
    const briefingWindow = typeof body.briefing_window === 'string' ? body.briefing_window : '24h';

    // ─── Idempotency: look for an existing ledger row with this item id ───
    try {
      const r = await fetch(
        `${cfg.url}/rest/v1/vtid_ledger?metadata->>source_action_item_id=eq.${encodeURIComponent(itemId)}&select=vtid,status,title&limit=1`,
        { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } },
      );
      if (r.ok) {
        const rows = (await r.json()) as Array<{ vtid: string; status: string; title: string }>;
        if (rows.length > 0) {
          return res.json({
            ok: true,
            idempotent: true,
            vtid: rows[0].vtid,
            existing_status: rows[0].status,
            existing_title: rows[0].title,
            message: 'Action item already produced a VTID; returning the existing one.',
          });
        }
      }
    } catch {
      // best-effort idempotency check; if it fails we proceed and rely on
      // a unique-key violation downstream (none today, but allocator is
      // monotonic so worst case is one extra allocation).
    }

    // ─── Allocate VTID via canonical RPC ───
    let newVtid: string | null = null;
    try {
      const allocResp = await fetch(`${cfg.url}/rest/v1/rpc/allocate_global_vtid`, {
        method: 'POST',
        headers: {
          apikey: cfg.key,
          Authorization: `Bearer ${cfg.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_source: 'voice-improve-create-vtid',
          p_layer: 'INFRA',
          p_module: 'GATEWAY',
        }),
      });
      if (!allocResp.ok) {
        return res.status(500).json({ ok: false, error: `alloc_${allocResp.status}`, vtid: VTID });
      }
      const allocRows = (await allocResp.json()) as Array<{ vtid: string }>;
      newVtid = allocRows[0]?.vtid ?? null;
      if (!newVtid) {
        return res.status(500).json({ ok: false, error: 'alloc_no_vtid_returned', vtid: VTID });
      }
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message, vtid: VTID });
    }

    // ─── Populate ledger row, mirroring voice-lab.ts:840 invariants ───
    try {
      const patchResp = await fetch(
        `${cfg.url}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(newVtid)}`,
        {
          method: 'PATCH',
          headers: {
            apikey: cfg.key,
            Authorization: `Bearer ${cfg.key}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            title: `IMPROVE: ${title}`,
            summary:
              `${summary}\n\n---\n` +
              `Source: voice-improve cockpit\n` +
              `Action item: ${itemId}\n` +
              `Briefing window: ${briefingWindow}\n` +
              (sourceFiles.length ? `Files: ${sourceFiles.join(', ')}\n` : ''),
            layer: 'INFRA',
            module: 'GATEWAY',
            status: 'scheduled',
            spec_status: 'approved',
            assigned_to: 'autopilot',
            metadata: {
              source: 'voice-improve-create-vtid',
              source_action_item_id: itemId,
              source_briefing_window: briefingWindow,
              source_files: sourceFiles,
            },
            updated_at: new Date().toISOString(),
          }),
        },
      );
      if (!patchResp.ok) {
        return res.status(500).json({
          ok: false,
          error: `patch_${patchResp.status}`,
          vtid: VTID,
          allocated_vtid: newVtid,
        });
      }
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message, vtid: VTID, allocated_vtid: newVtid });
    }

    // ─── Emit OASIS event so the new row appears in the Self-Healing/Trace ───
    try {
      await emitOasisEvent({
        type: 'voice.improvement.vtid_created' as never,
        actor: req.identity?.user_id ?? 'system',
        payload: {
          vtid: newVtid,
          source_action_item_id: itemId,
          briefing_window: briefingWindow,
          gateway_vtid: VTID,
        },
      } as never);
    } catch {
      // never block the success path on telemetry
    }

    return res.json({
      ok: true,
      idempotent: false,
      vtid: newVtid,
      action_item_id: itemId,
    });
  },
);

// ---------------------------------------------------------------------------
// VTID-02867: GET /api/v1/voice/quality-by-provider
// Powers the quality strip on top of the Providers & Voice card. Lives
// under voice-improve (observability) — not voice-config (configuration).
// ---------------------------------------------------------------------------
router.get('/voice/quality-by-provider', requireDevAccess, async (req: Request, res: Response) => {
  try {
    const days = req.query.days ? Math.min(30, Math.max(1, parseInt(String(req.query.days), 10))) : 7;
    const rollup = await getProviderQualityRollup(days);
    res.json({ ok: true, ...rollup, vtid: 'VTID-02867' });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message, vtid: 'VTID-02867' });
  }
});

export default router;
