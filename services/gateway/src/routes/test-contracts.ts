/**
 * VTID-02954 (PR-L1): Test Contract Registry routes.
 *
 *   GET  /api/v1/test-contracts                 list + filter
 *   GET  /api/v1/test-contracts/:id             one row
 *   GET  /api/v1/test-contracts/by-capability/:capability
 *   POST /api/v1/test-contracts/:id/run         admin-only; allowlist-resolved
 *
 * Auth posture (explicit):
 *   - GET  → requireDevAccess (exafy_admin OR X-Gateway-Internal)
 *   - POST → stricter: requireAuthWithTenant + req.identity.exafy_admin.
 *     Run dispatch is admin-mutating (writes status='pending', then 'pass'/'fail').
 *
 * Safety:
 *   - The DB stores `command_key` (a string key), NOT a shell command.
 *   - /run resolves command_key against COMMAND_ALLOWLIST. Unknown key
 *     → 400. Never executes the database value as shell.
 *   - PR-L1 only dispatches `sync_http` allowlist entries. Other dispatch
 *     kinds (cloud_run_job, workflow_dispatch) are added in PR-L3.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  requireAuth,
  requireAuthWithTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { resolveCommand } from '../services/test-contract-commands';

const router = Router();
const VTID = 'VTID-02954';

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

// ---------------------------------------------------------------------------
// Local auth helper — same pattern as voice-improve.ts. Duplicated to keep
// routers loosely coupled; the logic is small.
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
      error: 'Test Contracts requires developer access (exafy_admin)',
      vtid: VTID,
    });
  });
  if (authFailed) return;
}

// ---------------------------------------------------------------------------
// GET /api/v1/test-contracts
// Filters (query): service, environment, owner, status, contract_type
// ---------------------------------------------------------------------------
router.get('/test-contracts', requireDevAccess, async (req: Request, res: Response) => {
  if (!supabaseConfigured()) {
    return res.status(500).json({ ok: false, error: 'supabase not configured', vtid: VTID });
  }
  const filters: string[] = [];
  if (req.query.service) filters.push(`service=eq.${encodeURIComponent(String(req.query.service))}`);
  if (req.query.environment)
    filters.push(`environment=eq.${encodeURIComponent(String(req.query.environment))}`);
  if (req.query.owner) filters.push(`owner=eq.${encodeURIComponent(String(req.query.owner))}`);
  if (req.query.status) filters.push(`status=eq.${encodeURIComponent(String(req.query.status))}`);
  if (req.query.contract_type)
    filters.push(`contract_type=eq.${encodeURIComponent(String(req.query.contract_type))}`);
  const query = filters.length > 0 ? '?' + filters.join('&') + '&order=capability.asc' : '?order=capability.asc';
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/test_contracts${query}`, {
      headers: supabaseHeaders(),
    });
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: 'database query failed', status: r.status, vtid: VTID });
    }
    const rows = await r.json();
    return res.json({ ok: true, contracts: rows, vtid: VTID });
  } catch (err) {
    return res.status(500).json({ ok: false, error: (err as Error).message, vtid: VTID });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/test-contracts/:id
// ---------------------------------------------------------------------------
router.get('/test-contracts/:id', requireDevAccess, async (req: Request, res: Response) => {
  if (!supabaseConfigured()) {
    return res.status(500).json({ ok: false, error: 'supabase not configured', vtid: VTID });
  }
  const id = String(req.params.id);
  // Basic UUID shape check to keep the URL out of being a query-injection vector
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ ok: false, error: 'invalid id format', vtid: VTID });
  }
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/test_contracts?id=eq.${id}&limit=1`,
      { headers: supabaseHeaders() },
    );
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: 'database query failed', vtid: VTID });
    }
    const rows = (await r.json()) as any[];
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', vtid: VTID });
    }
    return res.json({ ok: true, contract: rows[0], vtid: VTID });
  } catch (err) {
    return res.status(500).json({ ok: false, error: (err as Error).message, vtid: VTID });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/test-contracts/by-capability/:capability
// ---------------------------------------------------------------------------
router.get(
  '/test-contracts/by-capability/:capability',
  requireDevAccess,
  async (req: Request, res: Response) => {
    if (!supabaseConfigured()) {
      return res.status(500).json({ ok: false, error: 'supabase not configured', vtid: VTID });
    }
    const capability = String(req.params.capability);
    if (!/^[a-z0-9_]{3,128}$/.test(capability)) {
      return res.status(400).json({ ok: false, error: 'invalid capability format', vtid: VTID });
    }
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/test_contracts?capability=eq.${encodeURIComponent(capability)}&limit=1`,
        { headers: supabaseHeaders() },
      );
      if (!r.ok) {
        return res.status(502).json({ ok: false, error: 'database query failed', vtid: VTID });
      }
      const rows = (await r.json()) as any[];
      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'NOT_FOUND', vtid: VTID });
      }
      return res.json({ ok: true, contract: rows[0], vtid: VTID });
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message, vtid: VTID });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/test-contracts/:id/run
// Admin-only. Resolves command_key against COMMAND_ALLOWLIST. PR-L1
// supports sync_http dispatch only; other dispatch kinds return 501.
// ---------------------------------------------------------------------------
router.post(
  '/test-contracts/:id/run',
  requireAuthWithTenant,
  async (req: Request, res: Response) => {
    if (!supabaseConfigured()) {
      return res.status(500).json({ ok: false, error: 'supabase not configured', vtid: VTID });
    }
    const identity = (req as AuthenticatedRequest).identity;
    if (!identity || identity.exafy_admin !== true) {
      return res.status(403).json({
        ok: false,
        error: 'admin access required to run test contracts',
        vtid: VTID,
      });
    }
    const id = String(req.params.id);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ ok: false, error: 'invalid id format', vtid: VTID });
    }
    // Step 1: load the contract
    const fetchResp = await fetch(
      `${SUPABASE_URL}/rest/v1/test_contracts?id=eq.${id}&limit=1`,
      { headers: supabaseHeaders() },
    );
    if (!fetchResp.ok) {
      return res.status(502).json({ ok: false, error: 'database query failed', vtid: VTID });
    }
    const rows = (await fetchResp.json()) as any[];
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', vtid: VTID });
    }
    const contract = rows[0];

    // Step 2: resolve the command_key against the allowlist
    const command = resolveCommand(contract.command_key);
    if (!command) {
      return res.status(400).json({
        ok: false,
        error: 'COMMAND_KEY_NOT_ALLOWLISTED',
        message: `command_key '${contract.command_key}' is not in COMMAND_ALLOWLIST. Add an entry in services/gateway/src/services/test-contract-commands.ts first.`,
        vtid: VTID,
      });
    }

    // Step 3: PR-L1 only supports sync_http
    if (command.dispatch !== 'sync_http') {
      return res.status(501).json({
        ok: false,
        error: 'DISPATCH_NOT_IMPLEMENTED_IN_PR_L1',
        message: `dispatch='${command.dispatch}' lands in PR-L3 (test_contract_runs table + Cloud Run Job)`,
        vtid: VTID,
      });
    }

    // Step 4: run the resolved typed function. Never an exec/spawn.
    const result = await command.resolve(contract.expected_behavior);

    // Step 5: persist run state
    const newStatus = result.passed ? 'pass' : 'fail';
    const previousStatus = contract.status as string;
    const failureSignature = result.passed
      ? null
      : `${command.command_key}:${result.failure_reason || 'unknown'}`;
    const patchBody: Record<string, unknown> = {
      status: newStatus,
      last_run_at: result.ran_at,
      last_status: previousStatus,
      last_failure_signature: failureSignature,
    };
    if (result.passed) {
      // Last-passing SHA tracking requires a known SHA. PR-L1 doesn't have
      // that yet — Phase 3's failure scanner runs against deployed revisions
      // and will pass in the deployed SHA. For now we leave last_passing_sha
      // alone and only update it when the caller provides it.
    }
    await fetch(`${SUPABASE_URL}/rest/v1/test_contracts?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(patchBody),
    }).catch((err) => {
      // Persistence failure is non-fatal for the response — return the
      // result; the cockpit will see the stale row on next refresh.
      console.warn(`[${VTID}] failed to persist run result for ${id}: ${err}`);
    });

    // Step 6: emit OASIS event for state transition observability
    try {
      await emitOasisEvent({
        vtid: VTID,
        type: result.passed
          ? ('test-contract.run.passed' as any)
          : ('test-contract.run.failed' as any),
        source: 'test-contracts',
        status: result.passed ? 'success' : 'warning',
        message: `Contract ${contract.capability} ${result.passed ? 'passed' : 'failed'}: ${
          result.failure_reason || `status=${result.status_code}`
        }`,
        payload: {
          contract_id: id,
          capability: contract.capability,
          command_key: command.command_key,
          passed: result.passed,
          status_code: result.status_code,
          duration_ms: result.duration_ms,
          failure_reason: result.failure_reason,
          actor_user_id: identity.user_id,
        },
      });
    } catch {
      /* non-fatal */
    }

    return res.json({
      ok: true,
      contract_id: id,
      capability: contract.capability,
      result,
      previous_status: previousStatus,
      new_status: newStatus,
      vtid: VTID,
    });
  },
);

export default router;
