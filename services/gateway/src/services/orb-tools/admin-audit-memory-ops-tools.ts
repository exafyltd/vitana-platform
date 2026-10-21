/**
 * Admin voice tools — Audit, i18n & Memory Ops (B16), Wave 6 (final wave)
 * of docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * Thin dispatch layer over routes/tenant-admin/audit-log.ts (requireTenantAdmin),
 * routes/admin-memory-broker.ts (requireAuth + requireExafyAdmin), and
 * routes/admin-embeddings-backfill.ts (requireAuth + requireExafyAdmin).
 *
 * admin_i18n_translate and admin_i18n_audit are SKIPPED. `translate-keys.mjs`
 * and the `i18n-audit-llm.yml` workflow referenced in vitana-v1's CLAUDE.md
 * live in the separate frontend repo — this gateway (vitana-platform) has no
 * route, script, or workflow that wires up either job. There's a generic
 * `dev_trigger_workflow` (Wave 2) that can dispatch any named workflow, but
 * pointing it at a workflow that doesn't exist in this repo would silently
 * fail rather than run a translation job; not built here. Both stay
 * `status: planned`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall, clampLimit } from './developer-tools';
import { adminGate, authHeaders, NO_ADMIN_SESSION } from './admin-users-rbac-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

function requireExafyAdmin(id: OrbToolIdentity): OrbToolResult | null {
  const denied = adminGate(id);
  if (denied) return denied;
  if (String(id.role ?? '').toLowerCase() !== 'exafy_admin') {
    return { ok: false, error: 'This tool requires an exafy_admin session (operator-only).' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. admin_audit_actions_log — GET .../audit/actions
// ---------------------------------------------------------------------------

export const admin_audit_actions_log: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const limit = clampLimit(args.limit, 50, 200);
  const qs = new URLSearchParams({ limit: String(limit) });
  if (typeof args.action === 'string' && args.action) qs.set('action', args.action);
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/audit/actions?${qs.toString()}`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { ok: false, error: `admin_audit_actions_log failed (${status}): ${String(body.error ?? 'unknown')}` };
  const actions = (Array.isArray(body.actions) ? body.actions : []) as unknown[];
  if (actions.length === 0) return { ok: true, result: { actions: [] }, text: 'No admin actions logged.' };
  return { ok: true, result: { actions }, text: `${actions.length} admin actions logged.` };
};

// ---------------------------------------------------------------------------
// 2. admin_audit_access_log — GET .../audit/access
// ---------------------------------------------------------------------------

export const admin_audit_access_log: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const limit = clampLimit(args.limit, 50, 200);
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/audit/access?limit=${limit}`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { ok: false, error: `admin_audit_access_log failed (${status}): ${String(body.error ?? 'unknown')}` };
  const accessLog = (Array.isArray(body.access_log) ? body.access_log : []) as unknown[];
  if (accessLog.length === 0) return { ok: true, result: { access_log: [] }, text: 'No access events logged.' };
  return { ok: true, result: { access_log: accessLog }, text: `${accessLog.length} access events logged.` };
};

// ---------------------------------------------------------------------------
// 3. admin_run_memory_consolidator — POST /api/v1/admin/consolidator/run
// ---------------------------------------------------------------------------

export const admin_run_memory_consolidator: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const targetUserId = typeof args.user_id === 'string' ? args.user_id.trim() : undefined;
  const targetTenantId = typeof args.tenant_id === 'string' ? args.tenant_id.trim() : undefined;
  const scoped = Boolean(targetUserId && targetTenantId);
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, scope: scoped ? { user_id: targetUserId, tenant_id: targetTenantId } : 'all_users' },
      text: scoped
        ? `About to run the memory consolidator for user ${targetUserId}. Confirm, then call again with confirm=true.`
        : `About to run the memory consolidator across ALL users — this is a heavy platform-wide sweep. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/consolidator/run', {
    method: 'POST',
    headers: authHeaders(id),
    body: {
      tenant_id: targetTenantId,
      user_id: targetUserId,
      loops: Array.isArray(args.loops) ? args.loops : undefined,
    },
  });
  if (!ok) return { ok: true, result: { ran: false, status, detail: body }, text: `Consolidator run failed to start: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: body, text: `Consolidator run ${String(body.run_id ?? '')}: ${String(body.status ?? 'unknown')}.` };
};

// ---------------------------------------------------------------------------
// 4. admin_run_embeddings_backfill — POST /api/v1/admin/embeddings/backfill
// ---------------------------------------------------------------------------

export const admin_run_embeddings_backfill: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const batchSize = clampLimit(args.batch_size, 50, 200);
  const dryRun = args.dry_run === true;
  if (!dryRun && args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, batch_size: batchSize },
      text: `About to backfill embeddings for up to ${batchSize} memory items. Confirm, then call again with confirm=true (or pass dry_run=true to preview without confirming).`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/embeddings/backfill', {
    method: 'POST',
    headers: authHeaders(id),
    body: { batch_size: batchSize, dry_run: dryRun },
  });
  if (!ok) return { ok: true, result: { ran: false, status, detail: body }, text: `Backfill failed: ${String(body.error ?? `gateway returned ${status}`)}.` };
  if (dryRun) return { ok: true, result: body, text: `Dry run: would process ${Number(body.would_process ?? 0)} items.` };
  return { ok: true, result: body, text: `Backfilled ${Number(body.processed_count ?? 0)} items, ${Number(body.errors_count ?? 0)} errors.` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ADMIN_AUDIT_MEMORY_OPS_TOOL_HANDLERS: Record<string, Handler> = {
  admin_audit_actions_log,
  admin_audit_access_log,
  admin_run_memory_consolidator,
  admin_run_embeddings_backfill,
};

export const ADMIN_AUDIT_MEMORY_OPS_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  { name: 'admin_audit_actions_log', description: 'ADMIN ONLY. Recent admin actions audit log.', parameters: { type: 'object', properties: { limit: { type: 'number' }, action: { type: 'string' } } } },
  { name: 'admin_audit_access_log', description: 'ADMIN ONLY. Recent login/logout/role-change access events.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
  {
    name: 'admin_run_memory_consolidator',
    description: 'EXAFY_ADMIN ONLY. Run the nightly memory consolidator on demand — scope to one user, or omit for a heavy all-users sweep. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { user_id: { type: 'string' }, tenant_id: { type: 'string' }, loops: { type: 'array', items: { type: 'string' } }, confirm: { type: 'boolean' } } },
  },
  {
    name: 'admin_run_embeddings_backfill',
    description: 'EXAFY_ADMIN ONLY. Backfill missing memory_items embeddings. TWO-STEP confirm (dry_run=true skips confirmation).',
    parameters: { type: 'object', properties: { batch_size: { type: 'number', description: '1-200, default 50.' }, dry_run: { type: 'boolean' }, confirm: { type: 'boolean' } } },
  },
];
