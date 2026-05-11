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

  // Step 2: Create the autopilot_recommendations row. source_type stays
  // 'dev_autopilot' (the existing allowlist value); spec_snapshot.scanner
  // marks the origin so the Self-Healing screen can filter.
  const title = `SELF-HEAL: ${diagnosis.service_name} — ${diagnosis.failure_class}`;
  const summary = diagnosis.root_cause.substring(0, 1000);
  const filesReferenced = (diagnosis.files_to_modify || []).slice(0, 30);
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
      spec_markdown: spec,
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
      plan_markdown: spec,
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
