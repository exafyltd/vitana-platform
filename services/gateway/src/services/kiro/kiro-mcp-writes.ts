/**
 * VTID-05006: the Operator's WRITE tools for a Kiro session (phase B).
 *
 * Every write call passes, in order:
 *   1. KIRO_MCP_WRITE_ENABLED=true          — one switch for all Kiro writes
 *   2. autopilot_* only: isAutopilotExecutionArmed() — the autopilot kill switch
 *   3. a `vtid` that exists, is not terminal, is in_progress + approved
 *   3b. the write's target (approval, execution, PR, push) belongs to that VTID
 *   4. the user's Allow in the Kiro thread (kiro-mcp-confirmations.ts)
 * and then runs through the same executor as the Operator (or, for the push,
 * kiro-push-branch.ts) within what is left of the call's 110 s budget.
 *
 * Deliberately NOT here: dev_deploy_service (its route is the decommissioned GCP
 * path, and production moves only through the owner's Gate 2), and the tools
 * that mint a VTID — autopilot_create_task, autopilot_run_task,
 * autopilot_activate_recommendation — because a VTID comes only after a sparred,
 * owner-approved plan (CLAUDE.md rules 51-55).
 */
import { getSupabase } from '../../lib/supabase';
import { getPullRequest } from '../github-service';
import { isAutopilotExecutionArmed } from '../system-controls-service';
import { emitOasisEvent } from '../oasis-event-service';
import { GEMINI_TOOL_DEFINITIONS } from '../gemini-operator';
import { requestConfirmation, KIRO_WRITE_CALL_BUDGET_MS } from './kiro-mcp-confirmations';
import { runOperatorTool, type KiroMcpCaller, type KiroMcpCallResult, type McpTool } from './kiro-mcp-tools';
import { KIRO_PUSH_TOOL, pushKiroBranch, type PushArgs } from './kiro-push-branch';

export const KIRO_MCP_WRITE_TOOLS = [
  // PRs (the push is Kiro-only; the rest are the Operator's own tools)
  'dev_push_kiro_branch', 'dev_create_pr', 'dev_merge_pr',
  // Dev Autopilot, on an existing VTID
  'autopilot_execute_task', 'autopilot_cancel_execution', 'autopilot_approve_execution', 'autopilot_reject_execution',
  // specs and approvals
  'dev_generate_spec', 'dev_validate_spec', 'dev_quality_check', 'dev_approve_spec', 'dev_approve_item', 'dev_reject_item',
] as const;

export function isKiroMcpWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KIRO_MCP_WRITE_ENABLED === 'true';
}
export function isKiroMcpWriteTool(name: string): boolean {
  return (KIRO_MCP_WRITE_TOOLS as readonly string[]).includes(name);
}

const VTID_PARAM = { type: 'string', description: 'The open VTID this action belongs to (required for every Kiro write).' };

function lower(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(lower);
  if (!v || typeof v !== 'object') return v;
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = k === 'type' && typeof x === 'string' ? x.toLowerCase() : lower(x);
  return o;
}

/** Tools whose own declaration has no `vtid`: the MCP layer adds it and strips it before the executor. */
const ADDED_VTID = new Set<string>();

let cached: McpTool[] | null = null;
export function kiroMcpWriteTools(): McpTool[] {
  if (cached) return cached;
  const decls = GEMINI_TOOL_DEFINITIONS.functionDeclarations as Array<{ name: string; description?: string; parameters?: any }>;
  const seen = new Set<string>();
  const out: McpTool[] = [KIRO_PUSH_TOOL as McpTool];
  for (const d of decls) {
    if (!isKiroMcpWriteTool(d.name) || d.name === 'dev_push_kiro_branch' || seen.has(d.name)) continue;
    seen.add(d.name);
    const schema = (lower(d.parameters) as any) ?? { type: 'object', properties: {} };
    schema.properties = { ...(schema.properties ?? {}) };
    if (!schema.properties.vtid) { schema.properties.vtid = VTID_PARAM; ADDED_VTID.add(d.name); }
    schema.required = Array.from(new Set([...(schema.required ?? []), 'vtid']));
    out.push({ name: d.name, description: `${d.description ?? d.name}\n\n[Kiro] Needs a vtid and the user's Allow in the thread before it runs.`, inputSchema: schema });
  }
  cached = out;
  return out;
}

/** VTID gate: exists, not terminal, in_progress + approved. */
export type VtidCheck = (vtid: string) => Promise<{ ok: true } | { ok: false; error: string }>;
export const checkVtidOpen: VtidCheck = async (vtid) => {
  if (!/^VTID-\d{5}$/.test(vtid)) return { ok: false, error: 'a vtid like VTID-01234 is required' };
  const db = getSupabase();
  if (!db) return { ok: false, error: 'ledger unavailable' };
  const { data, error } = await db.from('vtid_ledger').select('status, spec_status, is_terminal').eq('vtid', vtid).maybeSingle();
  if (error) return { ok: false, error: 'ledger unavailable' };
  const row = data as { status?: string; spec_status?: string; is_terminal?: boolean } | null;
  if (!row) return { ok: false, error: `${vtid} does not exist` };
  if (row.is_terminal) return { ok: false, error: `${vtid} is closed` };
  if (row.status !== 'in_progress' || row.spec_status !== 'approved') return { ok: false, error: `${vtid} is not in_progress + approved` };
  return { ok: true };
};

/**
 * The write's target must belong to the gated VTID (Codex review on #3977):
 * an approval id encodes its VTID, an execution row carries one, a PR's title
 * names it, a push's commit message must start with it. Tools whose executor
 * takes the vtid itself (create PR, execute task, specs) are bound by that.
 */
export type TargetCheck = (name: string, args: Record<string, any>, vtid: string) => Promise<{ ok: true } | { ok: false; error: string }>;
export const checkTargetVtid: TargetCheck = async (name, args, vtid) => {
  if (name === 'dev_approve_item' || name === 'dev_reject_item') {
    const m = /^appr_(VTID-\d{4,5})_/.exec(String(args.approval_id ?? ''));
    return m && m[1] === vtid ? { ok: true } : { ok: false, error: `approval ${String(args.approval_id ?? '')} is not for ${vtid}` };
  }
  if (name === 'autopilot_approve_execution' || name === 'autopilot_reject_execution' || name === 'autopilot_cancel_execution') {
    if (!args.execution_id) return name === 'autopilot_cancel_execution' ? { ok: true } : { ok: false, error: 'execution_id required' };
    const db = getSupabase();
    if (!db) return { ok: false, error: 'ledger unavailable' };
    const { data } = await db.from('dev_autopilot_executions').select('vtid').eq('id', String(args.execution_id)).limit(1);
    const row = Array.isArray(data) ? data[0] : data;
    return row && (row as { vtid?: string }).vtid === vtid ? { ok: true } : { ok: false, error: `execution ${String(args.execution_id)} is not for ${vtid}` };
  }
  if (name === 'dev_merge_pr') {
    try {
      const pr = await getPullRequest('exafyltd/vitana-platform', Number(args.pr_number));
      return String(pr?.title ?? '').includes(vtid) ? { ok: true } : { ok: false, error: `PR #${String(args.pr_number)} is not titled for ${vtid}` };
    } catch {
      return { ok: false, error: `PR #${String(args.pr_number)} not found` };
    }
  }
  if (name === 'dev_push_kiro_branch') {
    return String(args.message ?? '').startsWith(vtid) ? { ok: true } : { ok: false, error: `the commit message must start with ${vtid}` };
  }
  return { ok: true };
};

/** A short, human-readable line for the Allow/Deny card — never file contents or secrets. */
export function summarizeWrite(name: string, args: Record<string, any>): string {
  const pick = (k: string) => (args[k] === undefined ? '' : ` ${k}=${String(args[k]).slice(0, 80)}`);
  if (name === 'dev_push_kiro_branch') {
    const files = Array.isArray(args.files) ? args.files : [];
    const paths = files.slice(0, 5).map((f: any) => String(f?.path ?? '')).join(', ');
    return `Push ${files.length} file(s) to ${String(args.repo)}:${String(args.branch)} — ${paths}${files.length > 5 ? ', …' : ''}`;
  }
  return `${name}${pick('repo')}${pick('pr_number')}${pick('head_branch')}${pick('execution_id')}${pick('approval_id')}`.trim();
}

export interface WriteDeps {
  vtidCheck?: VtidCheck;
  targetCheck?: TargetCheck;
  armed?: () => Promise<boolean>;
  confirm?: typeof requestConfirmation;
  exec?: Parameters<typeof runOperatorTool>[3];
  push?: typeof pushKiroBranch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export async function callKiroMcpWrite(
  caller: KiroMcpCaller,
  name: string,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
  deps: WriteDeps = {},
): Promise<KiroMcpCallResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  if (!isKiroMcpWriteTool(name)) return { ok: false, text: `Unknown tool: ${name}` };
  if (!isKiroMcpWriteEnabled(deps.env)) return { ok: false, text: 'Kiro writes are switched off on this deployment (KIRO_MCP_WRITE_ENABLED).' };
  if (name.startsWith('autopilot_') && !(await (deps.armed ?? isAutopilotExecutionArmed)())) {
    return { ok: false, text: 'Autopilot execution is disarmed (emergency stop). Nothing was done.' };
  }
  const vtid = typeof rawArgs.vtid === 'string' ? rawArgs.vtid.trim() : '';
  const v = await (deps.vtidCheck ?? checkVtidOpen)(vtid);
  if (!v.ok) return { ok: false, text: `Refused: ${v.error}. Nothing was done.` };
  const t = await (deps.targetCheck ?? checkTargetVtid)(name, rawArgs as Record<string, any>, vtid);
  if (!t.ok) return { ok: false, text: `Refused: ${t.error}. Nothing was done.` };

  const confirm = await (deps.confirm ?? requestConfirmation)(
    { userId: caller.userId, threadId: caller.threadId, tool: name, vtid, summary: summarizeWrite(name, rawArgs as Record<string, any>) },
    signal,
  );
  emitOasisEvent({
    vtid: 'VTID-05006', type: 'operator.kiro.write_tool_called', source: 'gateway-operator',
    status: confirm.outcome === 'allowed' ? 'info' : 'warning',
    message: `Kiro asked to run ${name}: ${confirm.outcome}`, actor_id: caller.userId, actor_role: 'admin', surface: 'command-hub',
    payload: { tool: name, thread_id: caller.threadId, for_vtid: vtid, outcome: confirm.outcome, confirmation_id: confirm.id },
  }).catch(() => undefined);
  if (confirm.outcome === 'denied') return { ok: false, text: 'Denied by the user. Nothing was done.' };
  if (confirm.outcome !== 'allowed') return { ok: false, text: 'No answer from the user in time (or the call was cancelled). Nothing was done.' };
  if (signal.aborted) return { ok: false, text: 'The call was cancelled. Nothing was done.' };

  const left = Math.max(5_000, KIRO_WRITE_CALL_BUDGET_MS - (now() - started));
  if (name === 'dev_push_kiro_branch') {
    try {
      const r = await (deps.push ?? pushKiroBranch)(rawArgs as unknown as PushArgs, caller.userId);
      if (r.ok) {
        emitOasisEvent({
          vtid: 'VTID-05006', type: 'operator.kiro.branch_pushed', source: 'gateway-operator', status: 'success',
          message: `Kiro pushed ${r.files} file(s) to ${String(rawArgs.repo)}:${r.branch}`, actor_id: caller.userId, actor_role: 'admin', surface: 'command-hub',
          payload: { repo: rawArgs.repo, branch: r.branch, commit_sha: r.commit_sha, files: r.files, bytes: r.bytes, for_vtid: vtid, thread_id: caller.threadId },
        }).catch(() => undefined);
      }
      return { ok: r.ok, text: JSON.stringify(r) };
    } catch (e) {
      return { ok: false, text: `The push failed: ${e instanceof Error ? e.message.slice(0, 300) : 'error'}` };
    }
  }
  const args = { ...rawArgs };
  kiroMcpWriteTools(); // fills ADDED_VTID
  if (ADDED_VTID.has(name)) delete args.vtid;
  return runOperatorTool(caller, name, args, deps.exec, left);
}

