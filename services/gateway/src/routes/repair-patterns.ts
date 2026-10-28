/**
 * VTID-02970 (PR-L5): Repair pattern memory routes.
 *
 *   GET  /api/v1/test-contracts/patterns                  list (admin)
 *   POST /api/v1/test-contracts/patterns                  manual record (admin)
 *   POST /api/v1/test-contracts/patterns/:id/quarantine   manual quarantine (admin)
 *
 * The post-success auto-record path (reconciler hook) lands in PR-L5.1.
 * For v1, an operator manually records a pattern via POST /patterns
 * after they verify a successful repair. The lookup side is already
 * wired into the failure scanner (PR-L3 + PR-L5 spec_markdown).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  requireAuth,
  requireAuthWithTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import {
  recordPattern,
  listPatterns,
  type RecordPatternInput,
} from '../services/repair-pattern-store';

const router = Router();
const VTID = 'VTID-02970';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
  };
}

function supabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE);
}

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
    if (identity?.exafy_admin === true) return next();
    authFailed = true;
    res.status(403).json({ ok: false, error: 'developer access required (exafy_admin)', vtid: VTID });
  });
  if (authFailed) return;
}

// ---------------------------------------------------------------------------
// GET /api/v1/test-contracts/patterns
// ---------------------------------------------------------------------------
router.get('/test-contracts/patterns', requireDevAccess, async (req: Request, res: Response) => {
  if (!supabaseConfigured()) {
    return res.status(500).json({ ok: false, error: 'supabase not configured', vtid: VTID });
  }
  const includeQuarantined = String(req.query.include_quarantined || 'false') === 'true';
  try {
    const patterns = await listPatterns({ includeQuarantined });
    return res.json({ ok: true, total: patterns.length, patterns, vtid: VTID });
  } catch (err) {
    return res.status(500).json({ ok: false, error: (err as Error).message, vtid: VTID });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/test-contracts/patterns
//
// Body: { fault_signature, capability, target_file?, fix_diff,
//         source_pr_url?, source_repair_vtid? }
//
// Idempotent on (fault_signature, capability) — re-posting bumps
// success_count and refreshes the fix_diff.
// ---------------------------------------------------------------------------
router.post(
  '/test-contracts/patterns',
  requireAuthWithTenant,
  async (req: Request, res: Response) => {
    if (!supabaseConfigured()) {
      return res.status(500).json({ ok: false, error: 'supabase not configured', vtid: VTID });
    }
    const identity = (req as AuthenticatedRequest).identity;
    if (!identity || identity.exafy_admin !== true) {
      return res.status(403).json({
        ok: false,
        error: 'admin access required to record repair patterns',
        vtid: VTID,
      });
    }
    const body = req.body || {};
    const fault_signature = typeof body.fault_signature === 'string' ? body.fault_signature : null;
    const capability = typeof body.capability === 'string' ? body.capability : null;
    const fix_diff = typeof body.fix_diff === 'string' ? body.fix_diff : null;
    if (!fault_signature || !capability || !fix_diff) {
      return res.status(400).json({
        ok: false,
        error: 'fault_signature, capability, and fix_diff are required strings',
        vtid: VTID,
      });
    }
    if (fault_signature.length > 1024 || capability.length > 256 || fix_diff.length > 64_000) {
      return res.status(400).json({ ok: false, error: 'field too long', vtid: VTID });
    }
    const input: RecordPatternInput = {
      fault_signature,
      capability,
      target_file: typeof body.target_file === 'string' ? body.target_file : null,
      fix_diff,
      source_pr_url: typeof body.source_pr_url === 'string' ? body.source_pr_url : null,
      source_repair_vtid: typeof body.source_repair_vtid === 'string' ? body.source_repair_vtid : null,
    };
    try {
      const pattern = await recordPattern(input);
      if (!pattern) {
        return res.status(502).json({ ok: false, error: 'recordPattern returned null', vtid: VTID });
      }
      try {
        await emitOasisEvent({
          vtid: VTID,
          type: 'repair-pattern.recorded' as any,
          source: 'repair-pattern-store',
          status: 'info',
          message: `Recorded repair pattern for ${capability} (success_count=${pattern.success_count})`,
          payload: {
            pattern_id: pattern.id,
            capability,
            fault_signature: fault_signature.slice(0, 256),
            success_count: pattern.success_count,
            failure_count: pattern.failure_count,
            actor_user_id: identity.user_id,
          },
        });
      } catch { /* non-fatal */ }
      return res.status(pattern.success_count === 1 ? 201 : 200).json({
        ok: true,
        pattern,
        upserted: pattern.success_count > 1,
        vtid: VTID,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message, vtid: VTID });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/test-contracts/patterns/:id/quarantine
// ---------------------------------------------------------------------------
router.post(
  '/test-contracts/patterns/:id/quarantine',
  requireAuthWithTenant,
  async (req: Request, res: Response) => {
    if (!supabaseConfigured()) {
      return res.status(500).json({ ok: false, error: 'supabase not configured', vtid: VTID });
    }
    const identity = (req as AuthenticatedRequest).identity;
    if (!identity || identity.exafy_admin !== true) {
      return res.status(403).json({ ok: false, error: 'admin access required', vtid: VTID });
    }
    const id = String(req.params.id);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ ok: false, error: 'invalid id format', vtid: VTID });
    }
    const quarantined = req.body?.quarantined !== false; // default true
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/repair_patterns?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
        body: JSON.stringify({ quarantined }),
      });
      if (!r.ok) {
        return res.status(502).json({ ok: false, error: 'database PATCH failed', vtid: VTID });
      }
      const rows = (await r.json()) as any[];
      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'NOT_FOUND', vtid: VTID });
      }
      try {
        await emitOasisEvent({
          vtid: VTID,
          type: 'repair-pattern.quarantine.toggled' as any,
          source: 'repair-pattern-store',
          status: quarantined ? 'warning' : 'info',
          message: `Pattern ${id.slice(0, 8)} ${quarantined ? 'quarantined' : 're-armed'}`,
          payload: { pattern_id: id, quarantined, actor_user_id: identity.user_id },
        });
      } catch { /* non-fatal */ }
      return res.json({ ok: true, pattern: rows[0], vtid: VTID });
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message, vtid: VTID });
    }
  },
);

export default router;
