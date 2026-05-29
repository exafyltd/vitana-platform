/**
 * Self-Healing Injector Service
 * Injects diagnosed failures into the autopilot pipeline as VTID tasks.
 * The VTID is already allocated by the diagnosis phase — this service
 * transitions it from 'allocated' to 'pending' and emits the events
 * that trigger autopilot pickup.
 */

import { createHash } from 'crypto';
import { Diagnosis } from '../types/self-healing';
import { emitOasisEvent } from './oasis-event-service';
import { bridgeActivationToExecution } from './dev-autopilot-execute';
import { loadSourceFile } from './self-healing-diagnosis-service';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
  };
}

function computeSpecHash(spec: string): string {
  return createHash('sha256').update(spec).digest('hex');
}

/**
 * PR-A dedupe key: identifies a (endpoint, failure_class, spec_hash) tuple so
 * the same incident isn't injected twice while an autopilot execution is in
 * flight. Stored in autopilot_recommendations.spec_snapshot.dedupe_key.
 */
function computeDedupeKey(endpoint: string, failureClass: string, specHash: string): string {
  return createHash('sha256').update(`${endpoint}:${failureClass}:${specHash}`).digest('hex');
}

/**
 * Map service display name to vtid_ledger module value.
 */
function mapServiceToModule(serviceName: string): string {
  const map: Record<string, string> = {
    'Gateway': 'GATEWAY', 'Auth': 'GATEWAY', 'CI/CD': 'OASIS',
    'Execute Runner': 'OASIS', 'Operator': 'OASIS', 'Command Hub UI': 'COMHU',
    'Assistant': 'AGENTS', 'ORB Live': 'AGENTS', 'Voice Lab': 'AGENTS',
    'Autopilot': 'COMHU', 'Memory': 'GATEWAY', 'Health Capacity': 'GATEWAY',
    'Visual Interactive': 'GATEWAY', 'Conversation Intelligence': 'AGENTS',
  };
  return map[serviceName] || 'GATEWAY';
}

/**
 * Map self-healing confidence to autopilot risk_class.
 */
function confidenceToRiskClass(confidence: number): 'low' | 'medium' | 'high' {
  if (confidence >= 0.9) return 'low';
  if (confidence >= 0.7) return 'medium';
  return 'high';
}

/**
 * PR-H (VTID-02947): derive a paired test-file path for a source path.
 *
 * The autopilot safety gate's `tests_missing` rule (services/gateway/src/
 * services/dev-autopilot-safety.ts:221) refuses any plan that has
 * non-deletion edits without at least one test file in `files_to_modify`.
 * Self-healing diagnoses never propose tests on their own — so every
 * self-healing plan was being blocked at the safety gate, dead-ending
 * the green path even with PR-A's bridge wired.
 *
 * Strategy (existence-aware flat default):
 *   1. Only handle source paths under `services/gateway/src/**`. Anything
 *      else is "underived" — the caller MUST refuse the bridge so we
 *      never feed Dev Autopilot a knowingly gate-failing plan.
 *   2. Derive the basename (e.g. `availability` from `routes/availability.ts`).
 *   3. Probe three candidate test paths IN ORDER and use the first one
 *      that exists in the repo (via fs OR GitHub fallback — same
 *      loadSourceFile() helper PR-C added):
 *        a. services/gateway/test/<basename>.test.ts                (flat — most common)
 *        b. services/gateway/test/routes/<basename>.test.ts         (mirror — when source is /routes/)
 *        c. services/gateway/test/services/<basename>.test.ts       (mirror — when source is /services/)
 *   4. If none exists: fall back to the flat path (a). The autopilot LLM
 *      will create it. The plan footer makes the create-vs-modify
 *      contract explicit so the LLM doesn't try to modify a nonexistent
 *      file.
 *
 * Returns `null` for source paths the deriver cannot handle (outside
 * services/gateway/src/, no recognizable basename, etc.). The caller
 * uses `null` as the signal to refuse the bridge.
 */
async function deriveTestPathForSource(
  sourcePath: string,
  cache?: Map<string, any>,
): Promise<{ testPath: string; existing: boolean } | null> {
  // Only services/gateway/src/** is supported. The autopilot safety gate
  // also restricts edits to that tree (see allow_scope), so anything
  // else can't be auto-fixed regardless.
  if (!sourcePath.startsWith('services/gateway/src/')) return null;

  const fileName = sourcePath.split('/').pop() || '';
  const basename = fileName.replace(/\.(ts|tsx|js|jsx)$/, '');
  if (!basename || basename === fileName) return null; // no extension stripped → not a TS/JS source

  // index.ts is the gateway mounter — don't try to write a paired test for
  // it. The diagnosis layer should be redirected toward the actual route
  // file (Gap 2 / PR-F territory), not patched in index.ts.
  if (basename === 'index') return null;

  const candidates = [
    `services/gateway/test/${basename}.test.ts`,
    `services/gateway/test/routes/${basename}.test.ts`,
    `services/gateway/test/services/${basename}.test.ts`,
  ];

  for (const candidate of candidates) {
    try {
      const loaded = await loadSourceFile(candidate, cache);
      if (loaded.found) {
        return { testPath: candidate, existing: true };
      }
    } catch {
      // Continue to next candidate — don't let a transient GitHub error
      // mask a path that does exist via the next probe.
    }
  }

  // No paired test exists yet — default to the flat path; the autopilot
  // LLM will create it, and the plan footer says so explicitly.
  return { testPath: candidates[0], existing: false };
}

/**
 * PR-H (VTID-02947): turn a list of source paths into source+test pairs.
 *
 * Returns the augmented `files_referenced` list AND a list of the source
 * paths the deriver couldn't handle. If `underived` is non-empty, the
 * caller MUST refuse the bridge (refuse-to-bridge contract).
 */
async function deriveTestPathsForPlan(
  sourcePaths: string[],
): Promise<{
  files_referenced: string[];
  pairs: Array<{ source: string; test: string; test_existing: boolean }>;
  underived: string[];
}> {
  const cache = new Map<string, any>();
  const pairs: Array<{ source: string; test: string; test_existing: boolean }> = [];
  const underived: string[] = [];

  for (const source of sourcePaths) {
    const derived = await deriveTestPathForSource(source, cache);
    if (!derived) {
      underived.push(source);
      continue;
    }
    pairs.push({ source, test: derived.testPath, test_existing: derived.existing });
  }

  // De-duplicate test paths: two source files in the same module may map
  // to the same flat test path. Keep the order deterministic (sources
  // first, then tests in their natural order).
  const seen = new Set<string>();
  const files: string[] = [];
  for (const p of pairs) {
    if (!seen.has(p.source)) { files.push(p.source); seen.add(p.source); }
  }
  for (const p of pairs) {
    if (!seen.has(p.test)) { files.push(p.test); seen.add(p.test); }
  }

  return { files_referenced: files, pairs, underived };
}

/**
 * PR-H (VTID-02947): append a "Required deliverables" footer to the
 * spec markdown so the autopilot LLM emits BOTH the source fix AND a
 * paired test, and the plan-diff coverage check (validatePlanDiffCoverage
 * in dev-autopilot-execute.ts) gets a real assertion in the test file.
 *
 * Footer is appended (not replacing the diagnosis spec) so the LLM
 * still sees the original root-cause context. The wording is explicit
 * about create-vs-modify because the test file may not exist yet.
 */
function buildTestPathFooter(
  pairs: Array<{ source: string; test: string; test_existing: boolean }>,
): string {
  if (pairs.length === 0) return '';
  const lines: string[] = ['', '---', '', '## Required repair deliverables (autopilot safety gate enforces this)', ''];
  lines.push('Every PR for this self-healing task MUST include both a source change AND a test change. The autopilot safety gate refuses plans without a test file, and the plan-diff coverage check refuses PRs that ship only a placeholder. Concretely:');
  lines.push('');
  for (const { source, test, test_existing } of pairs) {
    const verb = test_existing ? 'modify' : 'create';
    lines.push(`- **${source}** — apply the fix that resolves the failing endpoint.`);
    lines.push(`  - **${test} (${verb})** — add or update a test that asserts the failure mode (described above) is now fixed. The test must call the same code path the failure exercised; passing-but-unrelated tests will be rejected by the executor's diff-coverage check.`);
  }
  lines.push('');
  lines.push('PRs that ship only one side of any pair will be auto-rejected.');
  return lines.join('\n');
}

/**
 * PR-A (VTID-02922): Bridge a self-healing VTID into the Dev Autopilot
 * execution pipeline so the proven runExecutionSession() patch-workspace
 * path actually edits files, opens a real PR, watches CI, and verifies
 * the live endpoint. Worker-runner no longer produces "claimed" file
 * changes — it polls the execution this function creates.
 *
 * Idempotency: if an active autopilot execution already exists for the
 * same dedupe_key (endpoint + failure_class + spec_hash), this function
 * skips insertion and reuses the existing execution_id.
 *
 * Returns the execution_id so the caller can record it on vtid_ledger.metadata.
 */
async function bridgeToAutopilotExecution(
  vtid: string,
  diagnosis: Diagnosis,
  spec: string,
  specHash: string,
): Promise<{ ok: boolean; execution_id?: string; deduped?: boolean; finding_id?: string; error?: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'supabase_not_configured' };
  }

  const dedupeKey = computeDedupeKey(diagnosis.endpoint, diagnosis.failure_class, specHash);

  // Step 1: Look for an existing active recommendation with the same
  // dedupe_key. Active = its linked execution isn't terminal.
  try {
    const existingResp = await fetch(
      `${SUPABASE_URL}/rest/v1/autopilot_recommendations?` +
        `spec_snapshot->>dedupe_key=eq.${dedupeKey}` +
        `&select=id,status&limit=5`,
      { headers: supabaseHeaders() },
    );
    if (existingResp.ok) {
      const existing = (await existingResp.json()) as Array<{ id: string; status: string }>;
      for (const rec of existing) {
        const execResp = await fetch(
          `${SUPABASE_URL}/rest/v1/dev_autopilot_executions?` +
            `finding_id=eq.${rec.id}` +
            `&status=not.in.(completed,failed,failed_escalated,reverted,cancelled,auto_archived,self_healed)` +
            `&select=id,status&order=created_at.desc&limit=1`,
          { headers: supabaseHeaders() },
        );
        if (execResp.ok) {
          const execs = (await execResp.json()) as Array<{ id: string; status: string }>;
          if (execs.length > 0) {
            await emitOasisEvent({
              type: 'self-healing.injection.deduped',
              vtid,
              source: 'self-healing-injector',
              status: 'info',
              message: `Reusing in-flight autopilot execution ${execs[0].id.slice(0, 8)} (status=${execs[0].status}) for dedupe_key ${dedupeKey.slice(0, 8)}`,
              payload: {
                dedupe_key: dedupeKey,
                existing_execution_id: execs[0].id,
                existing_finding_id: rec.id,
                existing_status: execs[0].status,
              },
            });
            return { ok: true, execution_id: execs[0].id, finding_id: rec.id, deduped: true };
          }
        }
      }
    }
  } catch (err: any) {
    console.warn(`[self-healing-injector] Dedupe check failed: ${err.message} — proceeding with fresh insert`);
  }

  // PR-H (VTID-02947): derive paired test paths BEFORE we touch any
  // autopilot table. If the deriver can't find a test path for any
  // source file, we refuse to bridge — feeding Dev Autopilot a plan
  // we know will fail the safety gate's `tests_missing` rule wastes
  // an LLM run AND surfaces as a cryptic safety-gate rejection
  // instead of a clear "we couldn't auto-fix this" signal.
  const sourcePaths = (diagnosis.files_to_modify || []).slice(0, 30);
  const derivation = await deriveTestPathsForPlan(sourcePaths);
  if (derivation.underived.length > 0) {
    const reason = `SELF_HEALING_TEST_PATH_UNDERIVED: cannot derive paired test path for ${derivation.underived.join(', ')}`;
    await emitOasisEvent({
      type: 'self-healing.execution.bridge_failed',
      vtid,
      source: 'self-healing-injector',
      status: 'warning',
      message: reason,
      payload: {
        endpoint: diagnosis.endpoint,
        failure_class: diagnosis.failure_class,
        confidence: diagnosis.confidence,
        underived_sources: derivation.underived,
        reason_code: 'SELF_HEALING_TEST_PATH_UNDERIVED',
      },
    });
    return { ok: false, error: reason };
  }

  // Step 2: Create the autopilot_recommendations row. source_type stays
  // 'dev_autopilot' (the existing allowlist value); spec_snapshot.scanner
  // marks the origin so the Self-Healing screen can filter.
  const title = `SELF-HEAL: ${diagnosis.service_name} — ${diagnosis.failure_class}`;
  const summary = diagnosis.root_cause.substring(0, 1000);
  // PR-H: files_referenced now includes BOTH source files AND their
  // derived test paths. The autopilot safety gate will see a test file
  // and pass the `tests_missing` check.
  const filesReferenced = derivation.files_referenced;
  // PR-H: append a "Required deliverables" footer so the LLM emits both
  // the fix AND the test (verb = create vs modify based on existence).
  const specWithFooter = spec + buildTestPathFooter(derivation.pairs);
  const recBody = {
    title,
    summary,
    domain: 'general',
    risk_level: 'medium',
    impact_score: 7,
    effort_score: 4,
    source_type: 'dev_autopilot',
    risk_class: confidenceToRiskClass(diagnosis.confidence),
    auto_exec_eligible: diagnosis.confidence >= 0.8,
    status: 'new',
    activated_vtid: vtid,
    spec_snapshot: {
      scanner: 'self-healing',
      vtid,
      dedupe_key: dedupeKey,
      endpoint: diagnosis.endpoint,
      failure_class: diagnosis.failure_class,
      confidence: diagnosis.confidence,
      spec_markdown: specWithFooter,
      files_referenced: filesReferenced,
      suggested_fix: diagnosis.suggested_fix,
      root_cause: diagnosis.root_cause,
    },
    spec_checksum: specHash,
  };

  const recResp = await fetch(`${SUPABASE_URL}/rest/v1/autopilot_recommendations`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(recBody),
  });
  if (!recResp.ok) {
    const errText = await recResp.text();
    return { ok: false, error: `autopilot_recommendations insert failed: ${recResp.status} ${errText.slice(0, 300)}` };
  }
  const recRows = (await recResp.json()) as Array<{ id: string }>;
  if (!recRows || recRows.length === 0) {
    return { ok: false, error: 'autopilot_recommendations insert returned no row' };
  }
  const findingId = recRows[0].id;

  // Step 3: Insert the plan_version row directly. runExecutionSession reads
  // plan_markdown + files_referenced from here, so this is the actual
  // execution-driving spec for the LLM. Note: dev_autopilot_plan_versions
  // has no `author` column (the original migration didn't include one); the
  // spec_snapshot.scanner='self-healing' marker on the recommendation is
  // how we identify origin downstream.
  const planResp = await fetch(`${SUPABASE_URL}/rest/v1/dev_autopilot_plan_versions`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      finding_id: findingId,
      version: 1,
      plan_markdown: specWithFooter,
      files_referenced: filesReferenced,
    }),
  });
  if (!planResp.ok) {
    const errText = await planResp.text();
    return { ok: false, error: `dev_autopilot_plan_versions insert failed: ${planResp.status} ${errText.slice(0, 300)}` };
  }

  // Step 4: Bridge to execution. bridgeActivationToExecution handles the
  // in-flight guard, calls approveAutoExecute (which creates the cooling
  // row), and patches execute_after to NOW so backgroundExecutorTick
  // picks it up on the next tick.
  const bridge = await bridgeActivationToExecution(findingId, null);
  if (!bridge.ok || !bridge.execution_id) {
    return {
      ok: false,
      error: `bridgeActivationToExecution failed: ${bridge.error || bridge.skipped || 'unknown'}`,
    };
  }

  await emitOasisEvent({
    type: 'self-healing.execution.bridged',
    vtid,
    source: 'self-healing-injector',
    status: 'info',
    message: `Self-healing bridged to autopilot execution ${bridge.execution_id.slice(0, 8)} for ${diagnosis.endpoint}`,
    payload: {
      dedupe_key: dedupeKey,
      finding_id: findingId,
      execution_id: bridge.execution_id,
      endpoint: diagnosis.endpoint,
      failure_class: diagnosis.failure_class,
      confidence: diagnosis.confidence,
    },
  });

  return { ok: true, execution_id: bridge.execution_id, finding_id: findingId, deduped: false };
}

/**
 * Inject a diagnosed failure into the autopilot pipeline.
 * The VTID already exists in vtid_ledger (created in diagnosis phase).
 * This function transitions it to 'pending' and attaches the spec.
 */
export async function injectIntoAutopilotPipeline(
  vtid: string,
  diagnosis: Diagnosis,
  spec: string,
  specHash: string,
): Promise<{ success: boolean; error?: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error('[self-healing-injector] Supabase not configured');
    return { success: false, error: 'supabase_not_configured' };
  }

  try {
    // Voice synthetic endpoints auto-approve regardless of confidence.
    // The safety net for voice rows is the synthetic Voice Probe + auto-rollback
    // + Spec Memory Gate (PR #4 + PR #3), not human approval.
    const isVoiceSyntheticSource =
      typeof diagnosis.endpoint === 'string' &&
      diagnosis.endpoint.startsWith('voice-error://');
    const autoApproved = isVoiceSyntheticSource || diagnosis.confidence >= 0.8;

    // Step 1: Update the existing VTID entry — transition allocated → pending
    const updateResp = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${vtid}`,
      {
        method: 'PATCH',
        headers: supabaseHeaders(),
        body: JSON.stringify({
          title: `SELF-HEAL: ${diagnosis.service_name} — ${diagnosis.failure_class}`,
          description: diagnosis.root_cause,
          summary: spec.substring(0, 2000),
          layer: 'INFRA',
          module: mapServiceToModule(diagnosis.service_name),
          status: 'scheduled',  // 'scheduled' is what worker-runner polls for and the standard pipeline expects
          spec_status: autoApproved ? 'approved' : 'validated',  // approved = auto-exec, validated = awaiting human
          assigned_to: 'autopilot',
          metadata: {
            source: 'self-healing',
            phase: 'injected',
            failure_class: diagnosis.failure_class,
            confidence: diagnosis.confidence,
            endpoint: diagnosis.endpoint,
            priority: 'critical',
            auto_approved: autoApproved,
            files_to_modify: diagnosis.files_to_modify,
            files_analyzed: diagnosis.files_read.length,
            evidence_count: diagnosis.evidence.length,
            max_attempts: 2,
            spec_hash: specHash,
          },
          updated_at: new Date().toISOString(),
        }),
      },
    );

    if (!updateResp.ok) {
      const errText = await updateResp.text();
      console.error(`[self-healing-injector] Failed to update vtid_ledger for ${vtid}: ${updateResp.status} ${errText}`);
      return { success: false, error: errText };
    }

    // Step 2: Emit injection event
    await emitOasisEvent({
      type: 'self-healing.task.injected',
      vtid,
      source: 'self-healing-injector',
      status: 'info',
      message: `Self-healing task injected into autopilot pipeline (confidence: ${(diagnosis.confidence * 100).toFixed(0)}%)`,
      payload: {
        service: diagnosis.service_name,
        endpoint: diagnosis.endpoint,
        failure_class: diagnosis.failure_class,
        confidence: diagnosis.confidence,
        auto_approved: autoApproved,
        files_to_modify: diagnosis.files_to_modify,
      },
    });

    // Step 3: Approval gate
    if (autoApproved) {
      // Level 1: Auto-approved — emit spec-created to trigger autopilot pickup
      await emitOasisEvent({
        type: 'autopilot.task.spec.created',
        vtid,
        source: 'self-healing-injector',
        status: 'info',
        message: `Self-healing spec auto-approved (confidence ${(diagnosis.confidence * 100).toFixed(0)}%)`,
        payload: { auto_approved: true, source: 'self-healing' },
      });
      console.log(`[self-healing-injector] ${vtid} auto-approved and injected into autopilot pipeline`);

      // Step 3b (PR-A): also bridge to the Dev Autopilot execution pipeline so
      // worker-runner's "describe-only" LLM call gets replaced with a real
      // patch-workspace + PR via runExecutionSession. Worker-runner detects
      // metadata.autopilot_execution_id and polls the execution status via the
      // new /await-autopilot-execution endpoint. Skipped if the bridge fails;
      // worker-runner's repair-evidence gate (PR #2045) will then correctly
      // refuse to mark the VTID succeeded without files_changed.
      if (!isVoiceSyntheticSource) {
        try {
          const bridge = await bridgeToAutopilotExecution(vtid, diagnosis, spec, specHash);
          if (bridge.ok && bridge.execution_id) {
            await fetch(`${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${vtid}`, {
              method: 'PATCH',
              headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
              body: JSON.stringify({
                metadata: {
                  source: 'self-healing',
                  phase: 'injected',
                  failure_class: diagnosis.failure_class,
                  confidence: diagnosis.confidence,
                  endpoint: diagnosis.endpoint,
                  priority: 'critical',
                  auto_approved: autoApproved,
                  files_to_modify: diagnosis.files_to_modify,
                  files_analyzed: diagnosis.files_read.length,
                  evidence_count: diagnosis.evidence.length,
                  max_attempts: 2,
                  spec_hash: specHash,
                  // PR-A linkage so worker-runner + reconciler can find it.
                  autopilot_execution_id: bridge.execution_id,
                  autopilot_finding_id: bridge.finding_id,
                  autopilot_deduped: bridge.deduped === true,
                  healing_state: 'execution_dispatched',
                },
                updated_at: new Date().toISOString(),
              }),
            });
            console.log(
              `[self-healing-injector] ${vtid} bridged to autopilot execution ${bridge.execution_id.slice(0, 8)}` +
                (bridge.deduped ? ' (deduped, reused existing)' : ''),
            );
          } else {
            console.warn(
              `[self-healing-injector] ${vtid} autopilot bridge failed: ${bridge.error || 'unknown'} — ` +
                `worker-runner will see no execution_id and the repair-evidence gate will refuse completion.`,
            );
            await emitOasisEvent({
              type: 'self-healing.execution.bridge_failed',
              vtid,
              source: 'self-healing-injector',
              status: 'warning',
              message: `Autopilot execution bridge failed: ${bridge.error || 'unknown'}`,
              payload: { error: bridge.error, endpoint: diagnosis.endpoint },
            });
          }
        } catch (bridgeErr: any) {
          console.error(`[self-healing-injector] ${vtid} autopilot bridge threw: ${bridgeErr.message}`);
        }
      }
    } else {
      // Level 2: Requires human approval — task appears in Command Hub approvals
      console.log(`[self-healing-injector] ${vtid} requires human approval (confidence ${(diagnosis.confidence * 100).toFixed(0)}%)`);
    }

    // Step 4: Insert into self_healing_log
    await fetch(`${SUPABASE_URL}/rest/v1/self_healing_log`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        vtid,
        endpoint: diagnosis.endpoint,
        failure_class: diagnosis.failure_class,
        confidence: diagnosis.confidence,
        diagnosis: {
          root_cause: diagnosis.root_cause,
          suggested_fix: diagnosis.suggested_fix,
          evidence_count: diagnosis.evidence.length,
          files_to_modify: diagnosis.files_to_modify,
          auto_fixable: diagnosis.auto_fixable,
        },
        spec_hash: specHash,
        outcome: 'pending',
        blast_radius: 'none',
        attempt_number: 1,
      }),
    }).catch(err => {
      console.warn(`[self-healing-injector] Failed to insert self_healing_log: ${err.message}`);
    });

    return { success: true };
  } catch (error: any) {
    console.error(`[self-healing-injector] Error injecting ${vtid}: ${error.message}`);
    return { success: false, error: error.message };
  }
}
