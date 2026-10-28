/**
 * VTID-04111: the Operator Console can ACTIVATE a Dev Autopilot recommendation
 * by id, from chat — not only from the Command Hub's own Activate button.
 *
 * Follow-up to VTID-04108 (Part 1 of 3 of the recommendation activation
 * bridge — generalizing which source_types a human "Activate" click can
 * push into a real Dev Autopilot execution). The prior attempt at this same
 * tool (VTID-04109) stalled inside the automated Dev Autopilot agent
 * executor — the DeepSeek model answered with empty text three turns in a
 * row instead of calling a tool ("model answered with text 3 times in a row
 * without calling finish") — a tool-call-compliance failure in that
 * pipeline, not a defect in the task itself. Implemented directly here.
 *
 *   autopilot_activate_recommendation(recommendation_id)
 *
 * Mirrors `autopilot_approve_execution` (VTID-04030,
 * operator-approval-tools.ts) in shape and posture: single required id,
 * the same VTID-03851 caller gate, the same `operator-chat:<user_id>`
 * actor convention, and it does exactly one irreversible thing on success —
 * no read/list companion tool, matching what the source task named.
 *
 * What "activate" means here — the SAME two steps
 * `POST /recommendations/:id/activate`'s developer/admin branch performs
 * (routes/autopilot-recommendations.ts), reused directly rather than
 * duplicated:
 *   1. RPC `activate_autopilot_recommendation` — allocates a VTID, flips
 *      the recommendation to status='activated', idempotent on a second call.
 *   2. `bridgeActivationToExecution()` (dev-autopilot-execute.ts, already
 *      exported and already used by this exact route) — for a
 *      manually-bridgeable source_type (VTID-04108's
 *      isManuallyBridgeableSourceType allowlist), generates a plan if none
 *      exists and creates the dev_autopilot_executions row with the
 *      cooldown skipped, so the next executor tick picks it up immediately
 *      instead of waiting on the reaper.
 *
 * Deliberately NOT reproduced here (scoped out, not silently dropped): the
 * route's oasis_specs markdown-draft generation and VTID-02935 alignment
 * telemetry emission. Both are non-fatal, best-effort enrichments on the
 * REST/UI path (wrapped in their own try/catch there); this chat tool's job
 * is to answer "activate recommendation X" with a VTID and, where
 * applicable, a running execution — not to reproduce every side effect of
 * the popup's own route handler. A future VTID can add them if an operator
 * actually needs the draft spec from chat.
 */

import { getThreadAuth, isExecuteTaskAuthorized, describeExecuteTaskRefusal } from './operator-execute-authz';
import { supa, getSupabase, bridgeActivationToExecution, type SupaConfig } from './dev-autopilot-execute';
import { isManuallyBridgeableSourceType } from './autopilot-executable-source-types';
import { emitOasisEvent } from './oasis-event-service';

const LOG_PREFIX = '[VTID-04111]';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActivateRecommendationToolResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

interface ActivateRpcResponse {
  ok: boolean;
  vtid?: string;
  error?: string;
  already_activated?: boolean;
  activated_at?: string;
  recommendation_id?: string;
  title?: string;
  status?: string;
}

/** Test seams; production callers pass nothing. */
export interface ActivateRecommendationToolDeps {
  s?: SupaConfig | null;
  activateRpc?: (s: SupaConfig, id: string, userId: string | null) => Promise<{ ok: boolean; data?: ActivateRpcResponse; error?: string }>;
  bridge?: (findingId: string, approvedBy: string | null) => ReturnType<typeof bridgeActivationToExecution>;
}

type Authz = { ok: true; actor: string; userId: string } | { ok: false; error: string };

/** The VTID-03851 gate, reworded for this tool — same pattern as operator-approval-tools.ts. */
export function authorizeActivateRecommendationTool(threadId: string): Authz {
  const auth = getThreadAuth(threadId);
  const z = isExecuteTaskAuthorized(auth);
  if (!z.ok) {
    return {
      ok: false,
      error: describeExecuteTaskRefusal(z.reason)
        .replace('autopilot_execute_task', 'autopilot_activate_recommendation')
        .replace('no execution was queued', 'nothing was activated'),
    };
  }
  return { ok: true, actor: `operator-chat:${auth!.user_id}`, userId: auth!.user_id };
}

async function callActivateRpc(
  s: SupaConfig,
  recommendationId: string,
  userId: string | null,
): Promise<{ ok: boolean; data?: ActivateRpcResponse; error?: string }> {
  const r = await supa<ActivateRpcResponse>(s, '/rest/v1/rpc/activate_autopilot_recommendation', {
    method: 'POST',
    body: JSON.stringify({ p_recommendation_id: recommendationId, p_user_id: userId }),
  });
  if (!r.ok) return { ok: false, error: r.error || `activate RPC failed (${r.status})` };
  return { ok: true, data: r.data };
}

/**
 * autopilot_activate_recommendation — activates a specific Dev Autopilot
 * recommendation by id: allocates its VTID (or returns the existing one,
 * idempotently) and, for a manually-bridgeable source_type, starts a real
 * execution with the cooldown skipped.
 */
export async function executeActivateRecommendation(
  args: { recommendation_id: string },
  threadId: string,
  deps: ActivateRecommendationToolDeps = {},
): Promise<ActivateRecommendationToolResult> {
  const authz = authorizeActivateRecommendationTool(threadId);
  if (!authz.ok) {
    console.warn(`${LOG_PREFIX} activate REFUSED thread=${threadId}`);
    return { ok: false, error: authz.error };
  }

  const recommendationId = typeof args?.recommendation_id === 'string' ? args.recommendation_id.trim() : '';
  if (!recommendationId) {
    return { ok: false, error: 'recommendation_id is required — the recommendation\'s UUID.' };
  }
  if (!UUID_RE.test(recommendationId)) {
    return { ok: false, error: `recommendation_id "${recommendationId}" is not a UUID.` };
  }

  const s = deps.s === undefined ? getSupabase() : deps.s;
  if (!s) return { ok: false, error: 'Supabase not configured — cannot activate.' };

  const activated = await (deps.activateRpc ?? callActivateRpc)(s, recommendationId, authz.userId);
  if (!activated.ok) {
    console.warn(`${LOG_PREFIX} activate ${recommendationId.slice(0, 8)} RPC failed: ${activated.error}`);
    return { ok: false, error: `activate failed: ${activated.error}` };
  }
  const response = activated.data;
  if (!response?.ok) {
    return { ok: false, error: response?.error || 'activation was rejected' };
  }

  console.log(`${LOG_PREFIX} activate ${recommendationId.slice(0, 8)} by ${authz.actor} → ${response.vtid}${response.already_activated ? ' (already activated)' : ''}`);

  if (!response.already_activated && response.vtid) {
    await emitOasisEvent({
      vtid: response.vtid,
      type: 'autopilot.recommendation.activated' as any,
      source: 'operator-chat',
      status: 'info',
      message: `Recommendation activated via Operator Console: ${response.title}`,
      payload: {
        recommendation_id: recommendationId,
        vtid: response.vtid,
        user_id: authz.userId,
        already_activated: false,
      },
    }).catch(err => console.warn(`${LOG_PREFIX} OASIS event emit failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`));
  }

  // Bridge into a real execution for a manually-bridgeable source_type
  // (VTID-04108) — same lookup + call the REST route makes, fire-and-forget
  // there because a slow LLM plan generation shouldn't block the HTTP
  // response; here we're already off the model's turn once this resolves,
  // so awaiting it lets the tool report the real outcome instead of "maybe".
  let bridge: { ok: boolean; execution_id?: string; error?: string; skipped?: string } | null = null;
  if (!response.already_activated && response.vtid) {
    try {
      const srcR = await supa<Array<{ source_type: string }>>(
        s,
        `/rest/v1/autopilot_recommendations?id=eq.${recommendationId}&select=source_type&limit=1`,
      );
      const srcType = srcR.ok && Array.isArray(srcR.data) ? srcR.data[0]?.source_type : undefined;
      if (isManuallyBridgeableSourceType(srcType)) {
        bridge = await (deps.bridge ?? bridgeActivationToExecution)(recommendationId, authz.userId);
        if (!bridge.ok) {
          console.warn(`${LOG_PREFIX} bridge for ${recommendationId.slice(0, 8)} failed: ${bridge.error}`);
        }
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} bridge lookup/dispatch error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const executionNote = bridge?.ok
    ? bridge.skipped
      ? ` An execution was already ${bridge.skipped} for this recommendation (execution ${bridge.execution_id?.slice(0, 8) ?? '?'}).`
      : ` A Dev Autopilot execution (${bridge.execution_id?.slice(0, 8) ?? '?'}) has been started with the cooldown skipped.`
    : bridge && !bridge.ok
      ? ` Activation succeeded but starting the execution failed: ${bridge.error}`
      : '';

  return {
    ok: true,
    data: {
      recommendation_id: recommendationId,
      vtid: response.vtid,
      title: response.title,
      status: response.status ?? 'activated',
      already_activated: response.already_activated === true,
      activated_at: response.activated_at ?? null,
      execution_id: bridge?.ok ? bridge.execution_id ?? null : null,
      message: response.already_activated
        ? `Already activated as ${response.vtid}.`
        : `Activated as ${response.vtid}.${executionNote}`,
    },
  };
}
