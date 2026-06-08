/**
 * VTID-02957 (PR-L2): Missing-Test Scanner routes.
 *
 *   GET  /api/v1/test-contracts/missing
 *        list every endpoint that does NOT yet have a test_contracts row
 *
 *   POST /api/v1/test-contracts/missing/:dedupe_key/allocate
 *        allocate one VTID for a specific gap and write an
 *        autopilot_recommendations row so the existing dev_autopilot
 *        pipeline can pick it up and produce a real PR. Idempotent by
 *        dedupe_key (no duplicate VTIDs on re-run).
 *
 * Auth: GET requires dev access (exafy_admin OR X-Gateway-Internal).
 *       POST requires admin. Allocation writes to vtid_ledger +
 *       autopilot_recommendations + emits OASIS events — admin-only is
 *       the right bar.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  requireAuth,
  requireAuthWithTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import {
  scanMissingContractsAgainstLiveRegistry,
  type CapabilityGap,
  type ExistingContractRef,
} from '../services/missing-test-scanner';
import { allocateVtid } from '../services/operator-service';

const router = Router();
const VTID = 'VTID-02957';

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
// Local auth helpers — same pattern as test-contracts.ts / voice-improve.ts.
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
      error: 'Missing-Test Scanner requires developer access (exafy_admin)',
      vtid: VTID,
    });
  });
  if (authFailed) return;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchExistingContracts(): Promise<ExistingContractRef[]> {
  if (!supabaseConfigured()) return [];
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/test_contracts?select=capability,service,contract_type`,
      { headers: supabaseHeaders() },
    );
    if (!r.ok) return [];
    return (await r.json()) as ExistingContractRef[];
  } catch {
    return [];
  }
}

interface ActiveDuplicate {
  vtid: string;
  status: string;
  is_terminal: boolean;
}

/**
 * Check vtid_ledger for an existing in-flight VTID with the same
 * dedupe_key. The missing-test scanner sets metadata.dedupe_key on
 * every VTID it allocates so re-runs are idempotent.
 */
async function findActiveVtidByDedupeKey(dedupe_key: string): Promise<ActiveDuplicate | null> {
  if (!supabaseConfigured()) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?metadata->>dedupe_key=eq.${encodeURIComponent(dedupe_key)}` +
      `&select=vtid,status,is_terminal&limit=1`,
      { headers: supabaseHeaders() },
    );
    if (!r.ok) return null;
    const rows = (await r.json()) as ActiveDuplicate[];
    if (rows.length === 0) return null;
    const row = rows[0];
    // Only treat as "duplicate" if it's still in-flight. Terminal VTIDs
    // (success/failed/cancelled) shouldn't block re-allocation — the
    // capability still needs a contract.
    return row.is_terminal ? null : row;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/test-contracts/missing
// ---------------------------------------------------------------------------
router.get('/test-contracts/missing', requireDevAccess, async (_req: Request, res: Response) => {
  if (!supabaseConfigured()) {
    return res.status(500).json({ ok: false, error: 'supabase not configured', vtid: VTID });
  }
  try {
    const existing = await fetchExistingContracts();
    const gaps = scanMissingContractsAgainstLiveRegistry(existing);
    return res.json({
      ok: true,
      total_endpoints: gaps.length + existing.length,
      covered: existing.length,
      missing: gaps.length,
      gaps,
      vtid: VTID,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: (err as Error).message, vtid: VTID });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/test-contracts/missing/:dedupe_key/allocate
// ---------------------------------------------------------------------------
router.post(
  '/test-contracts/missing/:dedupe_key/allocate',
  requireAuthWithTenant,
  async (req: Request, res: Response) => {
    if (!supabaseConfigured()) {
      return res.status(500).json({ ok: false, error: 'supabase not configured', vtid: VTID });
    }
    const identity = (req as AuthenticatedRequest).identity;
    if (!identity || identity.exafy_admin !== true) {
      return res.status(403).json({
        ok: false,
        error: 'admin access required to allocate VTIDs',
        vtid: VTID,
      });
    }
    const dedupe_key = String(req.params.dedupe_key);
    if (!/^[a-z0-9_:.\-]+$/i.test(dedupe_key) || dedupe_key.length > 256) {
      return res.status(400).json({ ok: false, error: 'invalid dedupe_key format', vtid: VTID });
    }

    // Step 1: re-scan to confirm this dedupe_key is still a real gap.
    // Avoids races where a contract was added between the cockpit GET and
    // this POST.
    const existing = await fetchExistingContracts();
    const gaps = scanMissingContractsAgainstLiveRegistry(existing);
    const gap = gaps.find((g: CapabilityGap) => g.dedupe_key === dedupe_key);
    if (!gap) {
      return res.status(404).json({
        ok: false,
        error: 'NOT_A_GAP',
        message: `dedupe_key '${dedupe_key}' is not in the current missing-contracts set — either it was just allocated, or the contract already exists.`,
        vtid: VTID,
      });
    }

    // Step 2: dedupe vs in-flight VTIDs.
    const duplicate = await findActiveVtidByDedupeKey(dedupe_key);
    if (duplicate) {
      return res.status(200).json({
        ok: true,
        deduped: true,
        existing_vtid: duplicate.vtid,
        existing_status: duplicate.status,
        message: `Active VTID ${duplicate.vtid} already covers this gap (status=${duplicate.status}). Re-allocation skipped.`,
        gap,
        vtid: VTID,
      });
    }

    // Step 3: allocate a fresh VTID.
    const alloc = await allocateVtid('missing-test-scanner', 'INFRA', 'GATEWAY');
    if (!alloc.ok || !alloc.vtid) {
      return res.status(502).json({
        ok: false,
        error: 'VTID_ALLOCATION_FAILED',
        message: alloc.message || 'allocator did not return a VTID',
        vtid: VTID,
      });
    }
    const newVtid = alloc.vtid;

    // Step 4: write an autopilot_recommendations row so the existing
    // dev_autopilot pipeline can pick it up. The spec instructs the LLM
    // to write the test file AND add the COMMAND_ALLOWLIST entry in the
    // same PR — both are required for the contract to actually run.
    const spec_markdown = `# Missing Test Contract: ${gap.capability}

The capability \`${gap.capability}\` (endpoint \`${gap.target_endpoint}\`, file \`${gap.target_file}\`) does not yet have a row in the \`test_contracts\` registry. Self-healing cannot detect runtime regressions on this capability until a contract exists.

## What to do

1. **Add a typed dispatcher** to \`services/gateway/src/services/test-contract-commands.ts\` \`COMMAND_ALLOWLIST\`:

   \`\`\`typescript
   '${gap.suggested_command_key}': {
     command_key: '${gap.suggested_command_key}',
     contract_type: 'live_probe',
     dispatch: 'sync_http',
     resolve: (expected) => probeHttp('GET', '${gap.target_endpoint}', isExpectedHttp(expected) ? expected : {}),
   },
   \`\`\`

2. **Add a follow-up migration** under \`supabase/migrations/\` that INSERTs a row into \`test_contracts\`:

   \`\`\`sql
   INSERT INTO test_contracts (
     capability, contract_type, command_key, service, environment,
     target_file, target_endpoint, expected_behavior, owner, repairable
   ) VALUES (
     '${gap.capability}',
     'live_probe',
     '${gap.suggested_command_key}',
     '${gap.service}',
     '${gap.environment}',
     '${gap.target_file}',
     '${gap.target_endpoint}',
     '{"status": [200, 401], "content_type_prefix": "application/json"}'::jsonb,
     'gateway-core',
     true
   ) ON CONFLICT (capability) DO NOTHING;
   \`\`\`

   Use \`status: [200, 401]\` (auth-gated routes legitimately return 401 when unauthenticated; that still proves the route is mounted). Tighten to \`status: 200\` only when you know the endpoint is public.

3. **Add a unit test** at \`services/gateway/test/test-contract-commands-${gap.capability}.test.ts\` that mocks fetch and verifies the new dispatcher returns \`passed: true\` for a 200 JSON response and \`passed: false\` for a 500.

## Dedupe key

\`${gap.dedupe_key}\` — the missing-test scanner uses this to avoid creating duplicate VTIDs for the same gap on re-run.
`;

    const recommendationId = crypto.randomUUID();
    const recInsertResp = await fetch(`${SUPABASE_URL}/rest/v1/autopilot_recommendations`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        id: recommendationId,
        title: `Write missing test contract: ${gap.capability}`,
        summary: `Endpoint ${gap.target_endpoint} (file ${gap.target_file}) has no test contract. Add a typed dispatcher + seed row + unit test.`,
        source_type: 'missing-test-scanner',
        status: 'new',
        risk_class: 'low',
        impact_score: 6,
        effort_score: 3,
        auto_exec_eligible: true,
        domain: 'gateway',
        // VTID-02979 (PR-M1.1 hotfix): `scanner` is NOT a column on
        // autopilot_recommendations — it lives in spec_snapshot.scanner.
        // The top-level field caused PostgREST to reject the entire INSERT
        // with PGRST204, leaving allocated VTIDs orphaned without a recommendation.
        spec_snapshot: {
          spec_markdown,
          files_referenced: [
            'services/gateway/src/services/test-contract-commands.ts',
            gap.target_file,
          ],
          scanner: 'missing-test-scanner',
          dedupe_key: dedupe_key,
          capability: gap.capability,
          target_endpoint: gap.target_endpoint,
        },
      }),
    });
    if (!recInsertResp.ok) {
      const errBody = await recInsertResp.text();
      console.warn(`[${VTID}] recommendation INSERT failed: ${errBody}`);
      // VTID was already allocated; we can still return success on the
      // allocation but flag the recommendation gap. The caller can retry.
      return res.status(502).json({
        ok: false,
        error: 'RECOMMENDATION_INSERT_FAILED',
        message: errBody,
        vtid: VTID,
        allocated_vtid: newVtid,
      });
    }

    // Step 5: write the VTID metadata so dedupe queries find this row.
    // The allocator's vtid_ledger row exists but won't have our
    // dedupe_key / repair_kind metadata yet.
    await fetch(`${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${newVtid}`, {
      method: 'PATCH',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        metadata: {
          source: 'missing-test-scanner',
          repair_kind: 'write_test',
          capability: gap.capability,
          dedupe_key,
          target_endpoint: gap.target_endpoint,
          target_file: gap.target_file,
          autopilot_finding_id: recommendationId,
          allocated_at: new Date().toISOString(),
          allocated_by: identity.user_id,
        },
      }),
    }).catch((err) => {
      console.warn(`[${VTID}] vtid_ledger metadata PATCH failed for ${newVtid}: ${err}`);
    });

    // Step 6: emit OASIS event
    try {
      await emitOasisEvent({
        vtid: newVtid,
        type: 'missing-test.scanner.allocated' as any,
        source: 'missing-test-scanner',
        status: 'info',
        message: `Allocated ${newVtid} to write missing test for ${gap.capability}`,
        payload: {
          dedupe_key,
          capability: gap.capability,
          target_endpoint: gap.target_endpoint,
          target_file: gap.target_file,
          recommendation_id: recommendationId,
          actor_user_id: identity.user_id,
          governance_vtid: 'VTID-02957',
        },
      });
    } catch {
      /* non-fatal */
    }

    return res.status(201).json({
      ok: true,
      allocated_vtid: newVtid,
      recommendation_id: recommendationId,
      dedupe_key,
      gap,
      vtid: VTID,
    });
  },
);

export default router;
