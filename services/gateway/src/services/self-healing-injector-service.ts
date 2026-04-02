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
    const autoApproved = diagnosis.confidence >= 0.8;

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
          status: 'allocated',  // must stay 'allocated' for autopilot event loop to pick up
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
