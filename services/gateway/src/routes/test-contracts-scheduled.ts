/**
 * VTID-02958 (PR-L3): Failure Scanner + scheduled runner routes.
 *
 *   POST /api/v1/test-contracts/scheduled-run
 *        Cron-driven (or manual) tick. Runs every live_probe contract,
 *        applies the debounce/quarantine state machine, allocates repair
 *        VTIDs when the rule fires. Auth: X-Gateway-Internal token (so
 *        Cloud Scheduler can hit it) OR admin.
 *
 *   GET  /api/v1/test-contracts/:id/runs
 *        Per-contract run history for the cockpit. Auth: dev access.
 *
 * Out of scope (lands in PR-L3.1):
 *   - Async dispatch for jest/typecheck contracts (Cloud Run Job)
 *   - Cloud Scheduler config (operator wires this manually post-merge)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  requireAuth,
  requireAuthWithTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import {
  decideScannerOutcome,
  runContractOnce,
  type ContractRow,
  type RecentRunRow,
} from '../services/test-contract-failure-scanner';
import { allocateVtid } from '../services/operator-service';
import { getDeployedSha } from '../services/self-healing-diagnosis-service';
import {
  buildRepairContext,
  renderRepairContextMarkdown,
} from '../services/test-contract-repair-context';
import { findPatternBySignature, type RepairPattern } from '../services/repair-pattern-store';

const router = Router();
const VTID = 'VTID-02958';

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
// Auth: scheduled-run accepts X-Gateway-Internal (for cron) OR admin.
// History GET accepts dev (exafy_admin OR internal token).
// ---------------------------------------------------------------------------

function isInternalCaller(req: Request): boolean {
  const token = process.env.GATEWAY_INTERNAL_TOKEN || '__dev__';
  return Boolean(
    process.env.GATEWAY_INTERNAL_TOKEN &&
      req.get('X-Gateway-Internal') === token,
  );
}

async function requireInternalOrAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (isInternalCaller(req)) return next();
  let authFailed = false;
  await requireAuthWithTenant(req as AuthenticatedRequest, res, () => {
    const identity = (req as AuthenticatedRequest).identity;
    if (identity?.exafy_admin === true) return next();
    authFailed = true;
    res.status(403).json({
      ok: false,
      error: 'scheduled-run requires X-Gateway-Internal token or exafy_admin',
      vtid: VTID,
    });
  });
  if (authFailed) return;
}

async function requireDevAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (isInternalCaller(req)) return next();
  let authFailed = false;
  await requireAuth(req as AuthenticatedRequest, res, () => {
    const identity = (req as AuthenticatedRequest).identity;
    if (identity?.exafy_admin === true) return next();
    authFailed = true;
    res.status(403).json({
      ok: false,
      error: 'developer access required (exafy_admin)',
      vtid: VTID,
    });
  });
  if (authFailed) return;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPatternMatchMarkdown(pattern: RepairPattern | null): string {
  if (!pattern) {
    return `## Pattern memory

_No prior pattern recorded for this fault_signature._ This is either a new failure mode or the first time we've seen it on this contract.`;
  }
  const trust =
    pattern.success_count >= 3
      ? 'high'
      : pattern.success_count >= 2
        ? 'medium'
        : 'low';
  const trustGuidance =
    trust === 'high'
      ? 'This fix has worked **3+ times**. Strong default — apply unless you see a clear reason it does not fit this case.'
      : trust === 'medium'
        ? 'This fix has worked **2 times**. Reasonable default — adapt if needed.'
        : 'This fix has worked **once**. Use as a hint, not a recipe — verify it actually applies to this failure before adopting verbatim.';
  return `## Pattern memory

A prior repair for the EXACT same fault_signature exists. **success_count=${pattern.success_count}**, **failure_count=${pattern.failure_count}**, last_used: ${pattern.last_used_at || 'never'}.

**Trust**: ${trust} — ${trustGuidance}

**Source**: ${pattern.source_pr_url || `repair_vtid ${pattern.source_repair_vtid || '(unknown)'}`} (capability: \`${pattern.capability}\`${pattern.target_file ? `, file: \`${pattern.target_file}\`` : ''})

### Prior fix_diff

\`\`\`diff
${pattern.fix_diff.slice(0, 4000)}${pattern.fix_diff.length > 4000 ? '\n... [truncated]' : ''}
\`\`\`

**Repair guidance**: this is reference material, not a mandate. The LLM should:
1. Read the prior diff in full.
2. Compare it to the current failure context above (failure_reason, body_excerpt, expected_behavior).
3. If the same fix applies cleanly, propose it adapted to the current target_file.
4. If the contexts differ, explain WHY the prior diff does not apply and write a fresh fix.
5. Never apply a stored diff blindly — the contract test is the ultimate arbiter.
`;
}

async function fetchScheduledContracts(): Promise<ContractRow[]> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/test_contracts?contract_type=eq.live_probe` +
      `&select=id,capability,service,environment,command_key,target_endpoint,target_file,expected_behavior,status,last_status,last_failure_signature,last_passing_sha,repairable` +
      `&order=capability.asc`,
    { headers: supabaseHeaders() },
  );
  if (!r.ok) return [];
  return (await r.json()) as ContractRow[];
}

async function fetchRecentRuns(contractId: string, limit: number): Promise<RecentRunRow[]> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/test_contract_runs?contract_id=eq.${contractId}` +
      `&select=id,passed,failure_signature,dispatched_at,repair_vtid` +
      `&order=dispatched_at.desc&limit=${limit}`,
    { headers: supabaseHeaders() },
  );
  if (!r.ok) return [];
  return (await r.json()) as RecentRunRow[];
}

// ---------------------------------------------------------------------------
// POST /api/v1/test-contracts/scheduled-run
// ---------------------------------------------------------------------------

interface PerContractOutcome {
  contract_id: string;
  capability: string;
  passed: boolean;
  new_status: string;
  reason: string;
  repair_vtid?: string;
  quarantined?: boolean;
  error?: string;
}

router.post(
  '/test-contracts/scheduled-run',
  requireInternalOrAdmin,
  async (req: Request, res: Response) => {
    if (!supabaseConfigured()) {
      return res.status(500).json({ ok: false, error: 'supabase not configured', vtid: VTID });
    }
    const actorUserId =
      (req as AuthenticatedRequest).identity?.user_id || 'scheduled-runner';
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    try {
      const contracts = await fetchScheduledContracts();
      const outcomes: PerContractOutcome[] = [];

      // Sequential — keeps the scanner gentle on Cloud Run + avoids
      // racing the same contract against itself if a tick fires twice.
      for (const contract of contracts) {
        try {
          const recent = await fetchRecentRuns(contract.id, 10);
          const result = await runContractOnce(contract);
          const decision = decideScannerOutcome(result, contract, recent, Date.now());

          // Allocate repair VTID FIRST (if needed) so the run record can
          // carry the repair_vtid link.
          let repairVtid: string | undefined;
          let repairRecommendationId: string | undefined;
          if (decision.should_allocate_repair) {
            const alloc = await allocateVtid('test-contract-failure-scanner', 'INFRA', 'GATEWAY');
            if (alloc.ok && alloc.vtid) {
              repairVtid = alloc.vtid;
              repairRecommendationId = randomUUID();
              const expectedExcerpt = JSON.stringify(contract.expected_behavior).slice(0, 500);

              // VTID-02967 (PR-L4): Known-good recovery context. Fetches
              // the file at last_passing_sha + current main and embeds
              // both versions + a diff summary into the spec_markdown so
              // the repair LLM can choose between revert / compensate /
              // investigate instead of guessing from scratch.
              const repairContext = await buildRepairContext({
                targetFile: contract.target_file,
                lastPassingSha: contract.last_passing_sha,
              });
              const knownGoodMd = renderRepairContextMarkdown(repairContext);

              // VTID-02970 (PR-L5): Pattern memory lookup. If we've
              // successfully repaired this exact failure_signature
              // before (>=2 successes), embed the prior fix_diff in the
              // spec as a reference. The LLM can choose to apply it
              // verbatim, adapt it, or ignore it if it sees a reason —
              // we don't skip the LLM. Direct application without LLM
              // review is a v1.1 follow-up that needs higher confidence
              // gates than v1 has.
              let patternMatch: RepairPattern | null = null;
              try {
                patternMatch = decision.failure_signature
                  ? await findPatternBySignature(decision.failure_signature)
                  : null;
              } catch (patternErr) {
                console.warn(`[${VTID}] pattern lookup failed for ${decision.failure_signature}: ${patternErr}`);
              }
              const patternMd = renderPatternMatchMarkdown(patternMatch);

              const specMarkdown = `# Failing test contract: ${contract.capability}

The contract \`${contract.capability}\` (\`${contract.command_key}\`, live_probe) is failing in production.

## Failure
- **failure_reason**: ${result.failure_reason || '(none)'}
- **failure_signature**: ${decision.failure_signature}
- **status_code**: ${result.status_code ?? '(null)'}
- **body_excerpt** (first 500 chars):
  \`\`\`
  ${(result.body_excerpt || '').slice(0, 500)}
  \`\`\`

## Contract expectations
\`\`\`json
${expectedExcerpt}
\`\`\`

${knownGoodMd}

${patternMd}

## Repair contract — HARD RULES (worker-runner enforces)

1. **Reproduce the failure locally first**. Run the exact \`command_key\` (\`${contract.command_key}\`) via \`POST /api/v1/test-contracts/<id>/run\` against your branch — you must see the SAME failure signature.
2. **Fix the underlying code in ${contract.target_file || '(unknown file)'}** until the live probe of \`${contract.target_endpoint || '(endpoint)'}\` satisfies the contract's \`expected_behavior\`.
3. **MUST NOT skip, delete, or weaken the failing assertion**. The contract row in \`test_contracts\` is the source of truth — do not modify \`expected_behavior\` unless the intended behavior of the system genuinely changed (in which case explain why in the PR description).
4. **Re-run the EXACT failing command** after your fix. The same probe must pass.
5. **Open a PR**, let CI go green, let EXEC-DEPLOY land. The post-deploy live probe is the final gate — the reconciler will not mark this VTID success until \`test_contracts.status='pass'\` on the deployed revision.

## Files in scope
- \`${contract.target_file || 'services/gateway/src/...'}\`
- \`services/gateway/test/...\` (paired test file; add if missing)

## Dedupe / governance
- failure_signature: \`${decision.failure_signature}\`
- contract_id: \`${contract.id}\`
- governance_vtid: VTID-02958
`;
              const recResp = await fetch(`${SUPABASE_URL}/rest/v1/autopilot_recommendations`, {
                method: 'POST',
                headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
                body: JSON.stringify({
                  id: repairRecommendationId,
                  title: `Fix failing contract: ${contract.capability}`,
                  summary: `Contract ${contract.capability} (${contract.command_key}) failing: ${result.failure_reason || 'unknown reason'}`,
                  source_type: 'test-contract-failure-scanner',
                  status: 'new',
                  risk_class: 'medium',
                  impact_score: 7,
                  effort_score: 4,
                  auto_exec_eligible: true,
                  domain: 'gateway',
                  scanner: 'test-contract-failure-scanner',
                  spec_snapshot: {
                    spec_markdown: specMarkdown,
                    files_referenced: [
                      contract.target_file,
                      'services/gateway/src/services/test-contract-commands.ts',
                    ].filter(Boolean),
                    scanner: 'test-contract-failure-scanner',
                    failure_signature: decision.failure_signature,
                    contract_id: contract.id,
                    capability: contract.capability,
                  },
                }),
              });
              if (recResp.ok) {
                // PATCH the VTID with the same metadata pattern as PR-L2
                // so reconciler + Pulse can find it.
                await fetch(`${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${repairVtid}`, {
                  method: 'PATCH',
                  headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
                  body: JSON.stringify({
                    metadata: {
                      source: 'test-contract-failure-scanner',
                      repair_kind: 'fix_failing_test',
                      capability: contract.capability,
                      contract_id: contract.id,
                      failure_signature: decision.failure_signature,
                      target_endpoint: contract.target_endpoint,
                      target_file: contract.target_file,
                      autopilot_finding_id: repairRecommendationId,
                      allocated_at: new Date().toISOString(),
                      allocated_by: actorUserId,
                    },
                  }),
                }).catch((err) => {
                  console.warn(`[${VTID}] vtid_ledger PATCH failed for ${repairVtid}: ${err}`);
                });
                try {
                  await emitOasisEvent({
                    vtid: repairVtid,
                    type: 'test-contract.repair.allocated' as any,
                    source: 'test-contract-failure-scanner',
                    status: 'warning',
                    message: `Allocated repair VTID ${repairVtid} for failing contract ${contract.capability}`,
                    payload: {
                      contract_id: contract.id,
                      capability: contract.capability,
                      failure_signature: decision.failure_signature,
                      reason: decision.reason,
                      governance_vtid: 'VTID-02958',
                    },
                  });
                } catch { /* non-fatal */ }
              } else {
                // Recommendation insert failed — we still ALLOCATED a VTID
                // we now can't drive. Surface it.
                console.warn(`[${VTID}] recommendation insert failed for ${repairVtid}: ${await recResp.text()}`);
              }
            } else {
              console.warn(`[${VTID}] VTID allocator failed: ${alloc.message}`);
            }
          }

          // Persist test_contract_runs row
          await fetch(`${SUPABASE_URL}/rest/v1/test_contract_runs`, {
            method: 'POST',
            headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
            body: JSON.stringify({
              contract_id: contract.id,
              passed: result.passed,
              status_code: result.status_code,
              content_type: result.content_type,
              duration_ms: result.duration_ms,
              failure_reason: result.failure_reason ?? null,
              body_excerpt: result.body_excerpt,
              failure_signature: decision.failure_signature,
              dispatched_by: isInternalCaller(req) ? 'scheduled_runner' : 'manual_admin',
              dispatched_at: result.ran_at,
              completed_at: new Date().toISOString(),
              repair_vtid: repairVtid ?? null,
              repair_recommendation_id: repairRecommendationId ?? null,
              run_metadata: { decision_reason: decision.reason, actor_user_id: actorUserId },
            }),
          }).catch((err) => {
            console.warn(`[${VTID}] test_contract_runs INSERT failed for ${contract.id}: ${err}`);
          });

          // PATCH test_contracts.{status, last_status, last_failure_signature, last_run_at}
          // VTID-02967 (PR-L4): on a passing run, stamp last_passing_sha
          // so the next failure can pull a real diff vs the known-good
          // version. Source: BUILD_INFO / DEPLOYED_GIT_SHA per PR-C.
          const patchBody: Record<string, unknown> = {
            status: decision.new_status,
            last_run_at: result.ran_at,
            last_status: contract.status,
            last_failure_signature: result.passed ? null : decision.failure_signature,
          };
          if (result.passed) {
            const sha = getDeployedSha();
            if (sha) {
              patchBody.last_passing_sha = sha;
              patchBody.branch_or_sha = sha;
            }
          }
          await fetch(`${SUPABASE_URL}/rest/v1/test_contracts?id=eq.${contract.id}`, {
            method: 'PATCH',
            headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
            body: JSON.stringify(patchBody),
          }).catch((err) => {
            console.warn(`[${VTID}] test_contracts PATCH failed for ${contract.id}: ${err}`);
          });

          // Emit OASIS for the run itself (passed/failed — separate from
          // the repair.allocated event above).
          try {
            await emitOasisEvent({
              vtid: VTID,
              type: result.passed
                ? ('test-contract.run.passed' as any)
                : ('test-contract.run.failed' as any),
              source: 'test-contract-failure-scanner',
              status: result.passed ? 'success' : 'warning',
              message: `Contract ${contract.capability} ${result.passed ? 'passed' : 'failed'}: ${result.failure_reason || `status=${result.status_code}`}`,
              payload: {
                contract_id: contract.id,
                capability: contract.capability,
                command_key: contract.command_key,
                passed: result.passed,
                status_code: result.status_code,
                duration_ms: result.duration_ms,
                failure_reason: result.failure_reason,
                decision_reason: decision.reason,
                repair_vtid: repairVtid,
              },
            });
          } catch { /* non-fatal */ }

          // Quarantine event — separate from the run event for filtering
          if (decision.should_quarantine) {
            try {
              await emitOasisEvent({
                vtid: VTID,
                type: 'test-contract.quarantined' as any,
                source: 'test-contract-failure-scanner',
                status: 'error',
                message: `Contract ${contract.capability} QUARANTINED — too many repair attempts in 24h`,
                payload: {
                  contract_id: contract.id,
                  capability: contract.capability,
                  reason: decision.reason,
                  governance_vtid: 'VTID-02958',
                },
              });
            } catch { /* non-fatal */ }
          }

          outcomes.push({
            contract_id: contract.id,
            capability: contract.capability,
            passed: result.passed,
            new_status: decision.new_status,
            reason: decision.reason,
            repair_vtid: repairVtid,
            quarantined: decision.should_quarantine || undefined,
          });
        } catch (perContractErr) {
          outcomes.push({
            contract_id: contract.id,
            capability: contract.capability,
            passed: false,
            new_status: contract.status,
            reason: 'scanner_threw',
            error: (perContractErr as Error).message,
          });
        }
      }

      const passed_count = outcomes.filter((o) => o.passed).length;
      const failed_count = outcomes.length - passed_count;
      const repairs_allocated = outcomes.filter((o) => o.repair_vtid).length;
      const quarantines = outcomes.filter((o) => o.quarantined).length;

      try {
        await emitOasisEvent({
          vtid: VTID,
          type: 'test-contract.scheduled_run.completed' as any,
          source: 'test-contract-failure-scanner',
          status: failed_count > 0 ? 'warning' : 'success',
          message: `Scheduled scan: ${passed_count} passed, ${failed_count} failed, ${repairs_allocated} repair VTIDs, ${quarantines} quarantines`,
          payload: {
            total_contracts: outcomes.length,
            passed_count,
            failed_count,
            repairs_allocated,
            quarantines,
            duration_ms: Date.now() - t0,
            actor_user_id: actorUserId,
            started_at: startedAt,
          },
        });
      } catch { /* non-fatal */ }

      return res.json({
        ok: true,
        scanned_at: startedAt,
        duration_ms: Date.now() - t0,
        total_contracts: outcomes.length,
        passed_count,
        failed_count,
        repairs_allocated,
        quarantines,
        outcomes,
        vtid: VTID,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message, vtid: VTID });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/v1/test-contracts/:id/runs
// ---------------------------------------------------------------------------
router.get(
  '/test-contracts/:id/runs',
  requireDevAccess,
  async (req: Request, res: Response) => {
    if (!supabaseConfigured()) {
      return res.status(500).json({ ok: false, error: 'supabase not configured', vtid: VTID });
    }
    const id = String(req.params.id);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ ok: false, error: 'invalid id format', vtid: VTID });
    }
    const limit = Math.min(parseInt(String(req.query.limit || '25'), 10), 100);
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/test_contract_runs?contract_id=eq.${id}` +
          `&select=id,passed,status_code,content_type,duration_ms,failure_reason,failure_signature,dispatched_by,dispatched_at,completed_at,repair_vtid` +
          `&order=dispatched_at.desc&limit=${limit}`,
        { headers: supabaseHeaders() },
      );
      if (!r.ok) {
        return res.status(502).json({ ok: false, error: 'database query failed', vtid: VTID });
      }
      const runs = await r.json();
      return res.json({ ok: true, contract_id: id, runs, vtid: VTID });
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message, vtid: VTID });
    }
  },
);

export default router;
