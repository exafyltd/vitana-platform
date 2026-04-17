/**
 * VTID-02300: Consent gate — outbound action lifecycle manager.
 *
 * The consent gate sits between the assistant's intent ("I want to add this
 * product to your cart") and the actual execution. Flow:
 *
 *   1. Tool handler calls createPendingAction() → row in pending_connector_actions
 *   2. UI receives the pending action via polling/SSE → renders ActionConfirmCard
 *   3. User approves → approvePendingAction() → executes → logs to action_ledger
 *   4. User denies → denyPendingAction() → logs denial to action_ledger
 *   5. Timeout (10 min default) → expirePendingActions() cron → logs expiry
 *
 * Safety rules:
 *   - Actions tagged `side_effect: 'purchase'` ALWAYS require consent
 *   - Actions tagged `side_effect: 'post'` ALWAYS require consent
 *   - Actions tagged `side_effect: 'write'` require consent unless the user
 *     has a blanket grant in user_action_permissions
 *   - Internal actions (cart.add) can skip consent if user has granted
 */

import { createHash } from 'crypto';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from './oasis-event-service';

// ==================== Types ====================

export type ActionType =
  | 'social_post_story'
  | 'wearable_log_workout'
  | 'shopping_add_to_list'
  | 'share_milestone'
  | 'calendar_add_event'
  | 'custom';

export type SideEffect = 'write' | 'post' | 'purchase';

export interface CreateActionInput {
  tenant_id: string;
  user_id: string;
  connector_id?: string;
  capability: string;
  action_type: ActionType;
  side_effect: SideEffect;
  preview_title: string;
  preview_description?: string;
  preview_data?: Record<string, unknown>;
  args: Record<string, unknown>;
  requested_by: 'orb' | 'autopilot' | 'operator' | 'user_ui';
  vtid?: string;
  recommendation_id?: string;
  product_id?: string;
  reversible?: boolean;
  expires_minutes?: number;
}

export interface PendingAction {
  id: string;
  state: string;
  action_type: string;
  preview_title: string;
  preview_description: string | null;
  preview_data: Record<string, unknown>;
  requested_by: string;
  requested_at: string;
  expires_at: string;
  connector_id: string | null;
  product_id: string | null;
}

export interface ActionExecutor {
  (args: Record<string, unknown>, ctx: { user_id: string; tenant_id: string; action_id: string }): Promise<{
    ok: boolean;
    external_id?: string;
    reversal_handle?: string;
    result?: Record<string, unknown>;
    error?: string;
  }>;
}

// ==================== Executor registry ====================

const EXECUTORS = new Map<ActionType, ActionExecutor>();

export function registerActionExecutor(actionType: ActionType, executor: ActionExecutor): void {
  EXECUTORS.set(actionType, executor);
}

// ==================== Core functions ====================

export async function createPendingAction(input: CreateActionInput): Promise<PendingAction | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  // Check if user has a blanket grant for this action type (skip consent)
  const { data: perm } = await supabase
    .from('user_action_permissions')
    .select('granted')
    .eq('user_id', input.user_id)
    .eq('action_type', input.action_type)
    .eq('granted', true)
    .maybeSingle();

  // Purchase + post actions ALWAYS require consent regardless of grants
  const requiresConsent =
    input.side_effect === 'purchase' ||
    input.side_effect === 'post' ||
    !perm?.granted;

  const expiresAt = new Date(Date.now() + (input.expires_minutes ?? 10) * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('pending_connector_actions')
    .insert({
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      connector_id: input.connector_id ?? null,
      capability: input.capability,
      action_type: input.action_type,
      preview_title: input.preview_title,
      preview_description: input.preview_description ?? null,
      preview_data: input.preview_data ?? {},
      args: input.args,
      requested_by: input.requested_by,
      state: requiresConsent ? 'pending' : 'approved',
      expires_at: expiresAt,
      reversible: input.reversible ?? false,
      vtid: input.vtid ?? null,
      recommendation_id: input.recommendation_id ?? null,
      product_id: input.product_id ?? null,
    })
    .select('id, state, action_type, preview_title, preview_description, preview_data, requested_by, requested_at, expires_at, connector_id, product_id')
    .single();

  if (error || !data) {
    console.error('[consent-gate] createPendingAction failed:', error?.message);
    return null;
  }

  // If auto-approved (blanket grant + non-purchase/post), execute immediately
  if (data.state === 'approved') {
    executeAction(data.id, input.user_id, input.tenant_id).catch((err) => {
      console.error('[consent-gate] auto-execute failed:', err);
    });
  }

  await emitOasisEvent({
    vtid: input.vtid ?? 'VTID-02300',
    type: 'connector.action.requested' as never,
    source: 'gateway',
    status: 'info',
    message: `Action requested: ${input.action_type} (${data.state === 'pending' ? 'awaiting consent' : 'auto-approved'})`,
    payload: {
      action_id: data.id,
      user_id: input.user_id,
      action_type: input.action_type,
      state: data.state,
      requested_by: input.requested_by,
    },
  }).catch(() => {});

  return data as PendingAction;
}

export async function approvePendingAction(actionId: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, error: 'DB unavailable' };

  const { data: action, error: fetchErr } = await supabase
    .from('pending_connector_actions')
    .select('id, user_id, tenant_id, state, expires_at, action_type, args')
    .eq('id', actionId)
    .eq('user_id', userId)
    .single();

  if (fetchErr || !action) return { ok: false, error: 'Action not found' };
  if (action.state !== 'pending') return { ok: false, error: `Action is ${action.state}, not pending` };
  if (new Date(action.expires_at) < new Date()) {
    await supabase.from('pending_connector_actions').update({ state: 'expired' }).eq('id', actionId);
    return { ok: false, error: 'Action expired' };
  }

  await supabase
    .from('pending_connector_actions')
    .update({ state: 'approved', approved_at: new Date().toISOString() })
    .eq('id', actionId);

  // Execute
  const result = await executeAction(actionId, userId, action.tenant_id);
  return result;
}

export async function denyPendingAction(actionId: string, userId: string): Promise<{ ok: boolean }> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false };

  await supabase
    .from('pending_connector_actions')
    .update({ state: 'denied', denied_at: new Date().toISOString() })
    .eq('id', actionId)
    .eq('user_id', userId);

  // Audit log
  const { data: action } = await supabase
    .from('pending_connector_actions')
    .select('tenant_id, action_type, capability, args, preview_title, requested_by, requested_at, vtid, recommendation_id, product_id')
    .eq('id', actionId)
    .single();

  if (action) {
    await supabase.from('action_ledger').insert({
      tenant_id: action.tenant_id,
      user_id: userId,
      action_id: actionId,
      action_type: action.action_type,
      capability: action.capability,
      args_hash: createHash('sha256').update(JSON.stringify(action.args)).digest('hex').slice(0, 16),
      args_snapshot: action.args as object,
      preview_title: action.preview_title,
      outcome: 'denied',
      requested_by: action.requested_by,
      vtid: action.vtid,
      recommendation_id: action.recommendation_id,
      product_id: action.product_id,
      requested_at: action.requested_at,
    });

    await emitOasisEvent({
      vtid: action.vtid ?? 'VTID-02300',
      type: 'connector.action.denied' as never,
      source: 'gateway',
      status: 'info',
      message: `Action denied: ${action.action_type}`,
      payload: { action_id: actionId, user_id: userId, action_type: action.action_type },
    }).catch(() => {});
  }

  return { ok: true };
}

export async function getUserPendingActions(userId: string): Promise<PendingAction[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from('pending_connector_actions')
    .select('id, state, action_type, preview_title, preview_description, preview_data, requested_by, requested_at, expires_at, connector_id, product_id')
    .eq('user_id', userId)
    .eq('state', 'pending')
    .order('requested_at', { ascending: false })
    .limit(10);
  return (data ?? []) as PendingAction[];
}

// ==================== Execution ====================

async function executeAction(actionId: string, userId: string, tenantId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, error: 'DB unavailable' };

  const { data: action } = await supabase
    .from('pending_connector_actions')
    .select('*')
    .eq('id', actionId)
    .single();
  if (!action) return { ok: false, error: 'Action not found' };

  await supabase
    .from('pending_connector_actions')
    .update({ state: 'executing' })
    .eq('id', actionId);

  const executor = EXECUTORS.get(action.action_type as ActionType);
  if (!executor) {
    await supabase
      .from('pending_connector_actions')
      .update({ state: 'failed', error: `No executor for ${action.action_type}`, failed_at: new Date().toISOString() })
      .eq('id', actionId);

    await supabase.from('action_ledger').insert({
      tenant_id: tenantId,
      user_id: userId,
      action_id: actionId,
      action_type: action.action_type,
      capability: action.capability,
      args_hash: createHash('sha256').update(JSON.stringify(action.args)).digest('hex').slice(0, 16),
      args_snapshot: action.args,
      preview_title: action.preview_title,
      outcome: 'failed',
      error: `No executor registered for ${action.action_type}`,
      requested_by: action.requested_by,
      requested_at: action.requested_at,
    });

    return { ok: false, error: `No executor for ${action.action_type}` };
  }

  try {
    const result = await executor(action.args as Record<string, unknown>, {
      user_id: userId,
      tenant_id: tenantId,
      action_id: actionId,
    });

    if (result.ok) {
      await supabase
        .from('pending_connector_actions')
        .update({
          state: 'executed',
          result: result.result ?? {},
          external_id: result.external_id ?? null,
          reversal_handle: result.reversal_handle ?? null,
          executed_at: new Date().toISOString(),
        })
        .eq('id', actionId);
    } else {
      await supabase
        .from('pending_connector_actions')
        .update({
          state: 'failed',
          error: result.error ?? 'Unknown error',
          failed_at: new Date().toISOString(),
        })
        .eq('id', actionId);
    }

    await supabase.from('action_ledger').insert({
      tenant_id: tenantId,
      user_id: userId,
      action_id: actionId,
      action_type: action.action_type,
      capability: action.capability,
      args_hash: createHash('sha256').update(JSON.stringify(action.args)).digest('hex').slice(0, 16),
      args_snapshot: action.args,
      preview_title: action.preview_title,
      outcome: result.ok ? 'executed' : 'failed',
      external_id: result.external_id,
      error: result.error,
      requested_by: action.requested_by,
      vtid: action.vtid,
      recommendation_id: action.recommendation_id,
      product_id: action.product_id,
      requested_at: action.requested_at,
    });

    await emitOasisEvent({
      vtid: action.vtid ?? 'VTID-02300',
      type: (result.ok ? 'connector.action.executed' : 'connector.action.failed') as never,
      source: 'gateway',
      status: result.ok ? 'info' : 'error',
      message: `Action ${result.ok ? 'executed' : 'failed'}: ${action.action_type}`,
      payload: {
        action_id: actionId,
        user_id: userId,
        action_type: action.action_type,
        external_id: result.external_id,
        error: result.error,
      },
    }).catch(() => {});

    return { ok: result.ok, error: result.error };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from('pending_connector_actions')
      .update({ state: 'failed', error: message, failed_at: new Date().toISOString() })
      .eq('id', actionId);
    return { ok: false, error: message };
  }
}

// ==================== Expiry cron ====================

export async function expirePendingActions(): Promise<number> {
  const supabase = getSupabase();
  if (!supabase) return 0;
  const { data } = await supabase
    .from('pending_connector_actions')
    .update({ state: 'expired' })
    .eq('state', 'pending')
    .lt('expires_at', new Date().toISOString())
    .select('id');
  return data?.length ?? 0;
}
