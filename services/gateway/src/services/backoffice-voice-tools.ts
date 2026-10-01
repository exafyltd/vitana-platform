/**
 * VTID-03848 — BackOffice voice tools for the ORB `/backoffice/*` surface.
 *
 * Four tools, all funnelled through the same orchestrator the HTTP route uses
 * (services/backoffice/command-orchestrator.ts), with `channel: 'voice'` —
 * so the policy engine's voice ceiling (Draft; GOLDEN-WORKFLOWS §3.3 rule 4)
 * applies by construction: a Commit or High-risk command spoken to the ORB is
 * rejected with `voice_not_permitted` before anything reaches ERPClaw, and
 * approvals can be READ here but never decided.
 *
 * Handlers re-check the surface and the identity server-side; a session on
 * another surface that somehow names one of these tools is denied.
 */
import { resolveAccess } from './backoffice/erp-access-resolver';
import { submitCommand, allowedCommandsFor, type OrchestratorCaller } from './backoffice/command-orchestrator';
import { getCommandStore } from './backoffice/command-store';
import { getCommandSpec } from '../constants/backoffice-commands';
import { hasCapability } from './backoffice/erp-access';
import { recallCustomerMemory } from './memory/customer';
import { getSupabase } from '../lib/supabase';

export interface BackOfficeToolContext {
  tenantId: string;
  userId: string;
  email: string | null;
  activeRole: string;
  isExafyAdmin: boolean;
  /** resolved ORB surface of the session; tools only run on 'backoffice' */
  surface: string;
  sessionId: string;
  turnNumber: number;
}

interface ToolResult { success: boolean; result: string; error?: string }

const deny = (error: string): ToolResult => ({ success: false, result: '', error });

function callerFrom(ctx: BackOfficeToolContext): OrchestratorCaller {
  // Voice sessions carry no MFA assurance claim; `aal: null` means "not MFA-backed",
  // which is exactly right — voice can never decide an approval anyway.
  return { user_id: ctx.userId, email: ctx.email, is_exafy_admin: ctx.isExafyAdmin, tenant_id: ctx.tenantId, active_role: ctx.activeRole, aal: null };
}

function guard(ctx: BackOfficeToolContext): ToolResult | null {
  if (ctx.surface !== 'backoffice') return deny('backoffice_surface_required');
  if (!ctx.tenantId || !ctx.userId) return deny('identity_required');
  return null;
}

/** Idempotency key for a spoken command: one per session turn + type, so a retried tool call replays instead of re-executing. */
function voiceIdempotencyKey(ctx: BackOfficeToolContext, type: string, explicit: unknown): string {
  if (typeof explicit === 'string' && /^[A-Za-z0-9_.:\-]{8,128}$/.test(explicit)) return explicit;
  return `voice:${ctx.sessionId}:${ctx.turnNumber}:${type}`.slice(0, 128);
}

export async function handleBackOfficeListCommands(ctx: BackOfficeToolContext, args: { domain?: string; tier?: string }): Promise<ToolResult> {
  const g = guard(ctx); if (g) return g;
  const access = await resolveAccess({ user_id: ctx.userId, is_exafy_admin: ctx.isExafyAdmin, tenant_id: ctx.tenantId, active_role: ctx.activeRole });
  let cmds = allowedCommandsFor(access);
  const domain = typeof args.domain === 'string' ? args.domain.trim().toLowerCase() : '';
  if (domain) cmds = cmds.filter((c) => c.type.startsWith(domain + '.') || c.domain.includes(domain));
  const tier = typeof args.tier === 'string' ? args.tier.trim().toLowerCase() : '';
  if (tier) cmds = cmds.filter((c) => c.tier === tier);
  const lines = cmds.slice(0, 60).map((c) => `${c.type} — ${c.tier}${c.tier === 'read' || c.tier === 'draft' ? ' (voice ok)' : ' (screen only from voice)'}`);
  return { success: true, result: JSON.stringify({ count: cmds.length, shown: lines.length, voice_ceiling: 'draft', commands: lines }) };
}

export async function handleBackOfficeCommand(ctx: BackOfficeToolContext, args: { type?: string; payload?: Record<string, unknown>; idempotency_key?: string }): Promise<ToolResult> {
  const g = guard(ctx); if (g) return g;
  const type = typeof args.type === 'string' ? args.type.trim() : '';
  if (!type || !getCommandSpec(type)) return deny('unknown_command_type');
  const payload = args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload) ? (args.payload as Record<string, unknown>) : {};
  const access = await resolveAccess({ user_id: ctx.userId, is_exafy_admin: ctx.isExafyAdmin, tenant_id: ctx.tenantId, active_role: ctx.activeRole });
  const out = await submitCommand(callerFrom(ctx), access, {
    type, payload, idempotency_key: voiceIdempotencyKey(ctx, type, args.idempotency_key), channel: 'voice', confirm: false,
  });
  const command = (out.body as any).command as Record<string, unknown> | undefined;
  const summary: Record<string, unknown> = {
    http: out.http,
    ok: (out.body as any).ok === true,
    status: command?.status ?? null,
    tier: command?.tier ?? null,
    reason: command?.reason ?? (out.body as any).error ?? null,
    command_id: command?.command_id ?? null,
    required_capability: (out.body as any).required_capability ?? null,
    entity: (out.body as any).entity ?? null,
    result: command?.receipt && typeof command.receipt === 'object' ? (command.receipt as any).result ?? null : null,
  };
  if (summary.reason === 'voice_not_permitted') {
    summary.next_step = 'This needs the screen: Commit-tier actions are confirmed there, High-risk ones go to Approvals. Offer to open the screen.';
  }
  return { success: summary.ok === true, result: JSON.stringify(summary), error: summary.ok ? undefined : String(summary.reason ?? 'command_failed') };
}

export async function handleBackOfficePendingApprovals(ctx: BackOfficeToolContext, args: { limit?: number }): Promise<ToolResult> {
  const g = guard(ctx); if (g) return g;
  const access = await resolveAccess({ user_id: ctx.userId, is_exafy_admin: ctx.isExafyAdmin, tenant_id: ctx.tenantId, active_role: ctx.activeRole });
  if (access.capabilities.length === 0 && !access.is_exafy_admin) return deny('no_backoffice_capabilities');
  const limit = Math.max(1, Math.min(20, Number(args.limit) || 10));
  const rows = await getCommandStore().listApprovals(ctx.tenantId, { status: 'pending', limit });
  return {
    success: true,
    result: JSON.stringify({
      count: rows.length,
      read_only: 'Approvals can be read by voice but only decided on the Approvals screen by a different person than the requester.',
      approvals: rows.map((a) => ({ approval_id: a.id, command_id: a.command_id, approve_capability: a.approve_capability, requested_by: a.requester_id, mine: a.requester_id === ctx.userId, reason: a.reason, created_at: a.created_at })),
    }),
  };
}

export async function handleBackOfficeMyAccess(ctx: BackOfficeToolContext, _args: Record<string, unknown>): Promise<ToolResult> {
  const g = guard(ctx); if (g) return g;
  const access = await resolveAccess({ user_id: ctx.userId, is_exafy_admin: ctx.isExafyAdmin, tenant_id: ctx.tenantId, active_role: ctx.activeRole });
  return { success: true, result: JSON.stringify({ role: access.role, is_exafy_admin: access.is_exafy_admin, capabilities: access.capabilities, voice_ceiling: 'draft' }) };
}

/**
 * VTID-04411: what the team has recorded about one customer — every executed
 * CRM/sales command about them, newest first. Read-only; needs crm.view or
 * sales.view.
 */
export async function handleBackOfficeCustomerMemory(ctx: BackOfficeToolContext, args: { customer?: string; limit?: number }): Promise<ToolResult> {
  const g = guard(ctx); if (g) return g;
  const ref = typeof args.customer === 'string' ? args.customer.trim() : '';
  if (!ref) return deny('customer_required');
  const access = await resolveAccess({ user_id: ctx.userId, is_exafy_admin: ctx.isExafyAdmin, tenant_id: ctx.tenantId, active_role: ctx.activeRole });
  if (!access.is_exafy_admin && !hasCapability(access, 'crm.view') && !hasCapability(access, 'sales.view')) return deny('capability_required: crm.view or sales.view');
  const sb = getSupabase();
  if (!sb) return deny('memory_unavailable');
  try {
    const entries = await recallCustomerMemory(sb, ctx.tenantId, ref, { limit: typeof args.limit === 'number' ? args.limit : 15 });
    return {
      success: true,
      result: JSON.stringify({
        customer: ref,
        count: entries.length,
        note: entries.length === 0 ? 'Nothing recorded for this customer yet (only commands executed through the BackOffice are remembered).' : undefined,
        entries: entries.map((e) => ({ when: e.occurred_at, what: e.content })),
      }),
    };
  } catch (err) {
    return deny(`memory_read_failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const BACKOFFICE_TOOL_HANDLERS: Record<string, (ctx: BackOfficeToolContext, args: any) => Promise<ToolResult>> = {
  backoffice_list_commands: handleBackOfficeListCommands,
  backoffice_command: handleBackOfficeCommand,
  backoffice_pending_approvals: handleBackOfficePendingApprovals,
  backoffice_my_access: handleBackOfficeMyAccess,
  backoffice_customer_memory: handleBackOfficeCustomerMemory,
};
export const BACKOFFICE_TOOL_NAMES = Object.keys(BACKOFFICE_TOOL_HANDLERS);

export const BACKOFFICE_TOOL_SCHEMAS = [
  {
    name: 'backoffice_list_commands',
    description: [
      'List the BackOffice typed commands this user is allowed to run, with their tier.',
      'Read and Draft commands can be run from voice; Commit and High-risk ones',
      'are screen-only (tell the user so and offer to open the screen).',
      'Optional filters: domain (crm, sales, finance, accounting, reports, settings)',
      'and tier (read, draft, commit, high).',
    ].join('\n'),
    parameters: { type: 'object', properties: { domain: { type: 'string' }, tier: { type: 'string' } }, required: [] },
  },
  {
    name: 'backoffice_command',
    description: [
      'Run ONE BackOffice typed command for the user, e.g. crm.lead.list,',
      'sales.invoice.list, accounting.account.balance, reports.ar_aging (Read) or',
      'crm.lead.create, sales.quotation.create, accounting.journal.create (Draft).',
      'payload holds the command parameters. To refer to a customer, account,',
      'lead or opportunity by NAME use customer_ref / account_ref / lead_ref /',
      'opportunity_ref — the system resolves exact matches only and returns',
      'candidates when the name is ambiguous; never pick one yourself, ask.',
      'From voice, Commit and High-risk commands are refused with',
      'voice_not_permitted — read that reason back and offer the screen.',
      'Read the outcome back from the result (status, numbers, ids); never claim',
      'something was posted unless status is executed.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'typed command, e.g. crm.lead.list' },
        payload: { type: 'object', description: 'command parameters (snake_case keys)' },
        idempotency_key: { type: 'string', description: 'optional; reuse the same key to retry the same request safely' },
      },
      required: ['type'],
    },
  },
  {
    name: 'backoffice_pending_approvals',
    description: 'Read the pending High-risk approval queue for this tenant (who requested what, which approver capability is needed). Read-only: approvals are decided on the Approvals screen by a different person, never by voice.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] },
  },
  {
    name: 'backoffice_my_access',
    description: 'Return the user\'s effective ERP capabilities and role so you can say precisely what they may and may not do here.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'backoffice_customer_memory',
    description: [
      'Recall what the team has recorded about ONE customer, lead, contact or',
      'opportunity: every BackOffice command executed about them (activities,',
      'tasks, updates, quotations, invoices), newest first. Use it before',
      'answering "what do we know about X" or before a follow-up call.',
      'customer is the name or id exactly as the user said it. Quote only what',
      'the entries say; if there are none, say nothing is recorded yet.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        customer: { type: 'string', description: 'customer / lead / contact / opportunity name or id' },
        limit: { type: 'number' },
      },
      required: ['customer'],
    },
  },
];
