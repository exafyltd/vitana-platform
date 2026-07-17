/**
 * Developer voice tools (VTID-02782).
 *
 * Voice access to the Command Hub's developer surfaces so a developer/admin
 * can ask the ORB about platform state instead of clicking through tabs:
 * VTID ledger (vtid_ledger), approvals queue (routes/approvals.ts), voice
 * sessions (Voice Lab / oasis_events), daily routines (routines +
 * routine_runs), self-healing (vtid_ledger + self_healing_log), autonomy
 * pulse (aggregatePulse from routes/autonomy-pulse.ts) and the agent
 * registry (agents_registry). Every handler re-checks the caller's role
 * server-side — only developer / admin / exafy_admin may execute, mirroring
 * the admin_role_required gate in services/admin-voice-tools.ts.
 *
 * Approve/reject reuse the EXACT logic behind the Command Hub buttons by
 * calling the gateway's own /api/v1/approvals routes (the same
 * gateway-self-call pattern routes/approvals.ts and routes/execute.ts use
 * for autonomous-pr-merge) — no new approval state machine is invented.
 */
import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

// ---------------------------------------------------------------------------
// Role gate — mirror of admin-voice-tools.ts (PRIVILEGED_ROLES / deny()),
// same error-code shape so pipelines treat it like admin_role_required.
// ---------------------------------------------------------------------------

const DEVELOPER_ROLES = new Set(['developer', 'admin', 'exafy_admin']);

/** Returns a deny result when the identity may not use developer tools, else null. */
export function developerGate(id: OrbToolIdentity): OrbToolResult | null {
  if (!id.user_id) {
    return { ok: false, error: 'developer tools require an authenticated user.' };
  }
  const role = String(id.role ?? '').toLowerCase();
  if (!DEVELOPER_ROLES.has(role)) {
    return { ok: false, error: 'developer_role_required' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function clampLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.round(n)));
}

/** Compact relative age for speech ("12 min ago", "3 h ago", "2 days ago"). */
export function relAge(iso: string | null | undefined): string {
  if (!iso) return 'unknown time';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'unknown time';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * Normalize spoken VTID references. Accepts "VTID-01234", "vtid 1234",
 * "1234" and returns candidate ledger keys (VTIDs are 4 or 5 digits, some
 * zero-padded, e.g. VTID-0542 and VTID-01200 both exist).
 */
export function normalizeVtidCandidates(raw: unknown): string[] {
  const s = String(raw ?? '').trim().toUpperCase();
  const m = s.match(/(\d{3,5})/);
  if (!m) return [];
  const digits = m[1].replace(/^0+(?=\d{4})/, ''); // trim leading zeros beyond 4 digits
  const out = new Set<string>();
  out.add(`VTID-${m[1]}`); // exactly as spoken
  out.add(`VTID-${digits.padStart(4, '0')}`);
  out.add(`VTID-${digits.padStart(5, '0')}`);
  return [...out];
}

/**
 * Deterministic approval id — MUST match generateApprovalId() in
 * routes/approvals.ts (appr_<vtid>_<sha256(vtid) first 6 hex>).
 */
export function approvalIdForVtid(vtid: string): string {
  const hash = createHash('sha256').update(vtid).digest('hex').slice(0, 6);
  return `appr_${vtid}_${hash}`;
}

/** Same gateway-self-call base the approvals route itself uses. */
export function gatewayBaseUrl(): string {
  return process.env.GATEWAY_URL || `http://localhost:${process.env.PORT || 8080}`;
}

/**
 * Generic gateway self-call, shared by every Wave 2 developer-tool domain
 * module (VTID/OASIS lifecycle, governance, CI/CD, deployment, observability)
 * so each one doesn't re-implement the same fetch-and-parse boilerplate.
 * Mirrors the narrower approvalsApi() below, just not fixed to one prefix.
 */
export async function gatewayApiCall(
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${gatewayBaseUrl()}${path}`, {
    method: init?.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON body — keep {} */
  }
  return { ok: res.ok, status: res.status, body };
}

async function approvalsApi(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  return gatewayApiCall(`/api/v1/approvals${path}`, init);
}

// ---------------------------------------------------------------------------
// dev_list_vtids — recent rows from vtid_ledger
// ---------------------------------------------------------------------------

interface VtidRow {
  vtid: string;
  title: string | null;
  description: string | null;
  status: string | null;
  spec_status: string | null;
  is_terminal: boolean | null;
  terminal_outcome?: string | null;
  claimed_by?: string | null;
  created_at: string;
  updated_at: string | null;
}

export const dev_list_vtids: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const limit = clampLimit(args.limit, 5, 20);
  const status = String(args.status ?? '').trim().toLowerCase();
  try {
    let q = sb
      .from('vtid_ledger')
      .select('vtid, title, description, status, spec_status, is_terminal, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    const rows = (data ?? []) as VtidRow[];
    if (rows.length === 0) {
      return {
        ok: true,
        result: { vtids: [] },
        text: status
          ? `No VTIDs with status "${status}" in the ledger.`
          : 'No VTIDs found in the ledger.',
      };
    }
    const lines = rows.map((r) => {
      const title = r.title || r.description || '(untitled)';
      return `${r.vtid} — ${title} (${r.status ?? 'unknown'}${r.spec_status ? `, spec ${r.spec_status}` : ''})`;
    });
    return {
      ok: true,
      result: { vtids: rows },
      text: `${rows.length} recent VTIDs${status ? ` with status ${status}` : ''}: ${lines.join('. ')}`,
    };
  } catch (err) {
    return { ok: false, error: `dev_list_vtids failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// dev_get_vtid_status — one VTID by (fuzzy) id
// ---------------------------------------------------------------------------

export const dev_get_vtid_status: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const candidates = normalizeVtidCandidates(args.vtid);
  if (candidates.length === 0) {
    return { ok: false, error: 'dev_get_vtid_status requires a VTID like "VTID-01234" or "1234".' };
  }
  try {
    const { data, error } = await sb
      .from('vtid_ledger')
      .select(
        'vtid, title, description, status, spec_status, is_terminal, terminal_outcome, claimed_by, created_at, updated_at',
      )
      .in('vtid', candidates)
      .limit(1);
    if (error) return { ok: false, error: error.message };
    const row = ((data ?? []) as VtidRow[])[0];
    if (!row) {
      return {
        ok: true,
        result: { found: false, candidates },
        text: `I could not find ${candidates[0]} in the VTID ledger.`,
      };
    }
    const title = row.title || row.description || '(untitled)';
    const parts = [
      `${row.vtid}: ${title}.`,
      `Status ${row.status ?? 'unknown'}, spec ${row.spec_status ?? 'unknown'}.`,
      row.is_terminal
        ? `Terminal with outcome ${row.terminal_outcome ?? 'unknown'}.`
        : 'Not terminal yet.',
      row.claimed_by ? `Claimed by ${row.claimed_by}.` : '',
      `Created ${relAge(row.created_at)}, updated ${relAge(row.updated_at)}.`,
    ].filter(Boolean);
    return { ok: true, result: { found: true, vtid: row }, text: parts.join(' ') };
  } catch (err) {
    return { ok: false, error: `dev_get_vtid_status failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// dev_list_pending_approvals / dev_count_approvals — approvals queue
// (same derived queue the Command Hub approvals view renders)
// ---------------------------------------------------------------------------

interface ApprovalItem {
  approval_id: string;
  vtid: string;
  title: string;
  pr_number: number | null;
  head_branch: string | null;
  checks_status: string;
  governance_status: string;
}

export const dev_list_pending_approvals: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const limit = clampLimit(args.limit, 5, 20);
  try {
    const { ok, status, body } = await approvalsApi(`/pending?limit=${limit}`);
    if (!ok || body.ok !== true) {
      return { ok: false, error: `approvals queue unavailable (${status}): ${String(body.error ?? 'unknown')}` };
    }
    const items = (Array.isArray(body.items) ? body.items : []) as ApprovalItem[];
    if (items.length === 0) {
      return { ok: true, result: { items: [] }, text: 'The approvals queue is empty — nothing is waiting for approval.' };
    }
    const lines = items.map((it) => {
      const pr = it.pr_number ? `PR #${it.pr_number}` : it.head_branch ? `branch ${it.head_branch}` : 'no PR yet';
      return `${it.vtid} "${it.title}" — ${pr}, checks ${it.checks_status}, governance ${it.governance_status}`;
    });
    return {
      ok: true,
      result: { items },
      text: `${items.length} item${items.length === 1 ? '' : 's'} waiting for approval: ${lines.join('. ')}. Say the VTID to approve or reject one.`,
    };
  } catch (err) {
    return { ok: false, error: `dev_list_pending_approvals failed: ${String((err as Error)?.message || err)}` };
  }
};

export const dev_count_approvals: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  try {
    const { ok, status, body } = await approvalsApi('/count');
    if (!ok || body.ok !== true) {
      return { ok: false, error: `approvals count unavailable (${status}): ${String(body.error ?? 'unknown')}` };
    }
    const n = Number(body.pending_count ?? 0);
    return {
      ok: true,
      result: { pending_count: n },
      text: n === 0
        ? 'There are no pending approvals right now.'
        : `There ${n === 1 ? 'is 1 item' : `are ${n} items`} waiting for approval.`,
    };
  } catch (err) {
    return { ok: false, error: `dev_count_approvals failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// dev_approve_pr / dev_reject_pr — confirm-gated mutations that call the
// exact routes the Command Hub approve/reject buttons call.
// ---------------------------------------------------------------------------

async function resolveApprovalTarget(
  args: OrbToolArgs,
  sb: SupabaseClient,
): Promise<{ approval_id: string; vtid: string } | { error: string }> {
  const givenId = String(args.approval_id ?? '').trim();
  if (givenId) {
    const m = givenId.match(/appr_(VTID-\d{4,5})_/);
    return { approval_id: givenId, vtid: m ? m[1] : givenId };
  }
  const candidates = normalizeVtidCandidates(args.vtid);
  if (candidates.length === 0) {
    return { error: 'Provide an approval_id or a VTID like "VTID-01234".' };
  }
  // Resolve the exact ledger VTID string first — the approval id is a hash
  // of the exact vtid text, so "1234" must become the real ledger key.
  const { data, error } = await sb
    .from('vtid_ledger')
    .select('vtid')
    .in('vtid', candidates)
    .limit(1);
  if (error) return { error: error.message };
  const row = ((data ?? []) as Array<{ vtid: string }>)[0];
  if (!row) return { error: `VTID ${candidates[0]} not found in the ledger.` };
  return { approval_id: approvalIdForVtid(row.vtid), vtid: row.vtid };
}

export const dev_approve_pr: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  try {
    const target = await resolveApprovalTarget(args, sb);
    if ('error' in target) return { ok: false, error: target.error };
    if (args.confirm !== true) {
      return {
        ok: true,
        result: { requires_confirmation: true, approval_id: target.approval_id, vtid: target.vtid },
        text: `Approving ${target.vtid} will merge its PR into main and trigger the staging deploy. Ask the developer to confirm, then call dev_approve_pr again with confirm=true.`,
      };
    }
    const { ok, status, body } = await approvalsApi(`/${encodeURIComponent(target.approval_id)}/approve`, {
      method: 'POST',
      body: {},
    });
    if (!ok || body.ok !== true) {
      return {
        ok: true,
        result: { approved: false, status, detail: body },
        text: `Approval of ${target.vtid} did not go through: ${String(body.error ?? `gateway returned ${status}`)}.`,
      };
    }
    const merged = Boolean((body.result as Record<string, unknown> | undefined)?.merged);
    return {
      ok: true,
      result: { approved: true, merged, detail: body.result ?? null },
      text: merged
        ? `${target.vtid} approved and its PR is merged. The push pipeline will deploy it to staging.`
        : `${target.vtid} approved. The merge is queued — checks may still be running.`,
    };
  } catch (err) {
    return { ok: false, error: `dev_approve_pr failed: ${String((err as Error)?.message || err)}` };
  }
};

export const dev_reject_pr: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const reason = String(args.reason ?? '').trim();
  if (!reason) {
    return { ok: false, error: 'dev_reject_pr requires a reason. Ask the developer why they are rejecting it.' };
  }
  try {
    const target = await resolveApprovalTarget(args, sb);
    if ('error' in target) return { ok: false, error: target.error };
    if (args.confirm !== true) {
      return {
        ok: true,
        result: { requires_confirmation: true, approval_id: target.approval_id, vtid: target.vtid, reason },
        text: `Ready to reject ${target.vtid} with reason "${reason}". Ask the developer to confirm, then call dev_reject_pr again with confirm=true.`,
      };
    }
    const { ok, status, body } = await approvalsApi(`/${encodeURIComponent(target.approval_id)}/reject`, {
      method: 'POST',
      body: { reason },
    });
    if (!ok || body.ok !== true) {
      return {
        ok: true,
        result: { rejected: false, status, detail: body },
        text: `Rejection of ${target.vtid} did not go through: ${String(body.error ?? `gateway returned ${status}`)}.`,
      };
    }
    return {
      ok: true,
      result: { rejected: true, vtid: target.vtid, reason },
      text: `${target.vtid} rejected. Reason recorded: ${reason}.`,
    };
  } catch (err) {
    return { ok: false, error: `dev_reject_pr failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// dev_list_voice_sessions — recent ORB voice sessions (Voice Lab source:
// oasis_events session start/stop topics, same as routes/voice-lab.ts)
// ---------------------------------------------------------------------------

const VOICE_SESSION_START_TOPICS = ['voice.live.session.started', 'vtid.live.session.start'];
const VOICE_SESSION_END_TOPICS = ['voice.live.session.ended', 'vtid.live.session.stop'];
const VOICE_LAB_VTIDS = ['VTID-01218A', 'VTID-01155', 'VTID-VOICE-HEALING', 'VTID-LIVEKIT-AGENT'];

interface VoiceEventRow {
  created_at: string;
  vitana_id?: string | null;
  metadata: Record<string, unknown> | null;
}

export const dev_list_voice_sessions: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const limit = clampLimit(args.limit, 5, 10);
  const statusFilter = String(args.status ?? 'all').toLowerCase();
  try {
    const [startsRes, endsRes] = await Promise.all([
      sb
        .from('oasis_events')
        .select('created_at, vitana_id, metadata')
        .in('topic', VOICE_SESSION_START_TOPICS)
        .in('vtid', VOICE_LAB_VTIDS)
        .order('created_at', { ascending: false })
        .limit(40),
      sb
        .from('oasis_events')
        .select('created_at, vitana_id, metadata')
        .in('topic', VOICE_SESSION_END_TOPICS)
        .in('vtid', VOICE_LAB_VTIDS)
        .order('created_at', { ascending: false })
        .limit(100),
    ]);
    if (startsRes.error) return { ok: false, error: startsRes.error.message };
    const starts = (startsRes.data ?? []) as VoiceEventRow[];
    const ends = ((endsRes.data ?? []) as VoiceEventRow[]).reduce((map, ev) => {
      const sid = String(ev.metadata?.session_id ?? '');
      if (sid && !map.has(sid)) map.set(sid, ev);
      return map;
    }, new Map<string, VoiceEventRow>());

    const sessions: Array<Record<string, unknown>> = [];
    for (const start of starts) {
      const sid = String(start.metadata?.session_id ?? '');
      if (!sid) continue;
      const end = ends.get(sid);
      const active = !end;
      if (statusFilter === 'active' && !active) continue;
      if (statusFilter === 'ended' && active) continue;
      const durationMs = Number(end?.metadata?.duration_ms ?? 0)
        || (end ? new Date(end.created_at).getTime() - new Date(start.created_at).getTime() : 0);
      sessions.push({
        session_id: sid,
        status: active ? 'active' : 'ended',
        started_at: start.created_at,
        duration_ms: durationMs || null,
        turn_count: Number(end?.metadata?.turn_count ?? end?.metadata?.turn_number ?? 0),
        lang: start.metadata?.lang ?? null,
        user_email: start.metadata?.email ?? null,
        user_role: start.metadata?.active_role ?? null,
      });
      if (sessions.length >= limit) break;
    }
    if (sessions.length === 0) {
      return {
        ok: true,
        result: { sessions: [] },
        text: statusFilter === 'active'
          ? 'No ORB voice sessions are active right now.'
          : 'No recent ORB voice sessions found.',
      };
    }
    const lines = sessions.map((s) => {
      const who = String(s.user_email ?? 'unknown user') + (s.user_role ? ` (${String(s.user_role)})` : '');
      const dur = s.duration_ms ? `, ${Math.max(1, Math.round(Number(s.duration_ms) / 60_000))} min` : '';
      const turns = Number(s.turn_count) > 0 ? `, ${Number(s.turn_count)} turns` : '';
      return `${who} — ${String(s.status)}, started ${relAge(String(s.started_at))}${dur}${turns}`;
    });
    return {
      ok: true,
      result: { sessions },
      text: `${sessions.length} recent voice session${sessions.length === 1 ? '' : 's'}: ${lines.join('. ')}`,
    };
  } catch (err) {
    return { ok: false, error: `dev_list_voice_sessions failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// dev_list_routines / dev_get_routine_detail — Claude daily routines
// (routines + routine_runs tables, same as routes/routines.ts)
// ---------------------------------------------------------------------------

interface RoutineRow {
  name: string;
  display_name: string | null;
  description?: string | null;
  cron_schedule: string | null;
  enabled: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_summary: string | null;
  consecutive_failures: number | null;
}

interface RoutineRunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  trigger: string | null;
  summary: string | null;
  error: string | null;
  duration_ms: number | null;
}

export const dev_list_routines: Handler = async (_args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  try {
    const { data, error } = await sb
      .from('routines')
      .select('name, display_name, cron_schedule, enabled, last_run_at, last_run_status, last_run_summary, consecutive_failures')
      .order('name', { ascending: true });
    if (error) return { ok: false, error: error.message };
    const rows = (data ?? []) as RoutineRow[];
    if (rows.length === 0) {
      return { ok: true, result: { routines: [] }, text: 'No daily routines are registered yet.' };
    }
    const failing = rows.filter((r) => r.last_run_status === 'failure' || (r.consecutive_failures ?? 0) > 0);
    const spoken = [...failing, ...rows.filter((r) => !failing.includes(r))].slice(0, 5);
    const lines = spoken.map((r) => {
      const name = r.display_name || r.name;
      const last = r.last_run_status
        ? `last run ${r.last_run_status} ${relAge(r.last_run_at)}`
        : 'never run';
      const fails = (r.consecutive_failures ?? 0) > 0 ? `, ${r.consecutive_failures} consecutive failures` : '';
      return `${name} — ${r.enabled ? 'enabled' : 'disabled'}, ${last}${fails}`;
    });
    const summary =
      `${rows.length} routines (${rows.filter((r) => r.enabled).length} enabled, ` +
      `${failing.length} failing).`;
    return { ok: true, result: { routines: rows }, text: `${summary} ${lines.join('. ')}` };
  } catch (err) {
    return { ok: false, error: `dev_list_routines failed: ${String((err as Error)?.message || err)}` };
  }
};

export const dev_get_routine_detail: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const rawName = String(args.name ?? '').trim();
  if (!rawName) return { ok: false, error: 'dev_get_routine_detail requires a routine name.' };
  const runsLimit = clampLimit(args.runs_limit, 5, 10);
  try {
    // Exact match first, then a fuzzy fallback so spoken names resolve.
    let routine: RoutineRow | undefined;
    const exact = await sb.from('routines').select('*').eq('name', rawName).limit(1);
    if (exact.error) return { ok: false, error: exact.error.message };
    routine = ((exact.data ?? []) as RoutineRow[])[0];
    if (!routine) {
      const needle = rawName.replace(/[,()%]/g, '').replace(/\s+/g, '%');
      const fuzzy = await sb
        .from('routines')
        .select('*')
        .or(`name.ilike.%${needle}%,display_name.ilike.%${needle}%`)
        .limit(1);
      if (fuzzy.error) return { ok: false, error: fuzzy.error.message };
      routine = ((fuzzy.data ?? []) as RoutineRow[])[0];
    }
    if (!routine) {
      return { ok: true, result: { found: false }, text: `I could not find a routine matching "${rawName}".` };
    }
    const runsRes = await sb
      .from('routine_runs')
      .select('id, started_at, finished_at, status, trigger, summary, error, duration_ms')
      .eq('routine_name', routine.name)
      .order('started_at', { ascending: false })
      .limit(runsLimit);
    if (runsRes.error) return { ok: false, error: runsRes.error.message };
    const runs = (runsRes.data ?? []) as RoutineRunRow[];
    const name = routine.display_name || routine.name;
    const head =
      `${name}: ${routine.enabled ? 'enabled' : 'disabled'}, schedule ${routine.cron_schedule ?? 'unknown'}. ` +
      (routine.last_run_status
        ? `Last run ${routine.last_run_status} ${relAge(routine.last_run_at)}${routine.last_run_summary ? ` — ${routine.last_run_summary}` : ''}.`
        : 'Never run.');
    const runLines = runs.map((r) => {
      const dur = r.duration_ms ? `, ${Math.max(1, Math.round(r.duration_ms / 60_000))} min` : '';
      const note = r.status === 'failure' && r.error ? ` (${r.error})` : r.summary ? ` — ${r.summary}` : '';
      return `${r.status} ${relAge(r.started_at)}${dur}${note}`;
    });
    return {
      ok: true,
      result: { found: true, routine, runs },
      text: runs.length > 0 ? `${head} Last ${runs.length} runs: ${runLines.join('. ')}` : head,
    };
  } catch (err) {
    return { ok: false, error: `dev_get_routine_detail failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// dev_list_active_healing — self-healing runs in flight
// (mirrors GET /api/v1/self-healing/active: vtid_ledger rows tagged
// metadata->>source=self-healing, plus pending self_healing_log diagnoses)
// ---------------------------------------------------------------------------

const HEALING_ACTIVE_STATUSES = ['allocated', 'pending', 'scheduled', 'in_progress', 'paused'];

interface HealLogRow {
  id: string;
  vtid: string | null;
  endpoint: string | null;
  failure_class: string | null;
  created_at: string;
}

export const dev_list_active_healing: Handler = async (_args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  try {
    const [tasksRes, pendingRes] = await Promise.all([
      sb
        .from('vtid_ledger')
        .select('vtid, title, status, spec_status, created_at')
        .filter('metadata->>source', 'eq', 'self-healing')
        .in('status', HEALING_ACTIVE_STATUSES)
        .order('created_at', { ascending: false })
        .limit(20),
      sb
        .from('self_healing_log')
        .select('id, vtid, endpoint, failure_class, created_at')
        .eq('outcome', 'pending')
        .order('created_at', { ascending: false })
        .limit(20),
    ]);
    if (tasksRes.error) return { ok: false, error: tasksRes.error.message };
    const tasks = (tasksRes.data ?? []) as VtidRow[];
    const pending = (pendingRes.data ?? []) as HealLogRow[];
    if (tasks.length === 0 && pending.length === 0) {
      return {
        ok: true,
        result: { active_tasks: [], pending_diagnoses: [] },
        text: 'Self-healing is quiet — no healing tasks in flight and no pending diagnoses.',
      };
    }
    const taskLines = tasks.slice(0, 5).map(
      (t) => `${t.vtid} — ${t.title || '(untitled)'} (${t.status}, ${relAge(t.created_at)})`,
    );
    const pendingLines = pending.slice(0, 3).map(
      (p) => `${p.failure_class ?? 'failure'} on ${p.endpoint ?? 'unknown endpoint'} (${relAge(p.created_at)})`,
    );
    const parts: string[] = [];
    parts.push(`${tasks.length} healing task${tasks.length === 1 ? '' : 's'} in flight` +
      (taskLines.length ? `: ${taskLines.join('. ')}` : '.'));
    parts.push(`${pending.length} pending diagnos${pending.length === 1 ? 'is' : 'es'}` +
      (pendingLines.length ? `: ${pendingLines.join('. ')}` : '.'));
    return {
      ok: true,
      result: { active_tasks: tasks, pending_diagnoses: pending },
      text: parts.join(' '),
    };
  } catch (err) {
    return { ok: false, error: `dev_list_active_healing failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// dev_get_autonomy_pulse — unified autonomy metrics. Fetches the exact four
// row sets routes/autonomy-pulse.ts fetches and reuses its exported pure
// aggregatePulse() so the voice answer matches the Command Hub Pulse view.
// ---------------------------------------------------------------------------

const EXECUTION_INFLIGHT_STATUSES = ['cooling', 'running', 'ci', 'merging', 'deploying', 'verifying'];

export const dev_get_autonomy_pulse: Handler = async (_args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  try {
    const [findingsRes, healsRes, execsRes, contractsRes, terminalizedRes] = await Promise.all([
      sb
        .from('autopilot_recommendations')
        .select('id, title, summary, risk_class, impact_score, effort_score, auto_exec_eligible, domain, first_seen_at, seen_count, spec_snapshot')
        .eq('source_type', 'dev_autopilot')
        .eq('status', 'new')
        .order('impact_score', { ascending: false, nullsFirst: false })
        .limit(50),
      sb
        .from('self_healing_log')
        .select('id, vtid, endpoint, failure_class, created_at, diagnosis, attempt_number')
        .eq('outcome', 'pending')
        .order('created_at', { ascending: false })
        .limit(50),
      sb
        .from('dev_autopilot_executions')
        .select('id, finding_id, status, pr_url, pr_number, branch, execute_after, auto_fix_depth, self_healing_vtid, created_at, updated_at')
        .in('status', EXECUTION_INFLIGHT_STATUSES)
        .order('created_at', { ascending: false })
        .limit(50),
      sb
        .from('test_contracts')
        .select('id, capability, service, environment, target_endpoint, target_file, owner, status, last_status, last_run_at, last_failure_signature')
        .in('status', ['fail', 'quarantined'])
        .order('last_run_at', { ascending: false, nullsFirst: false })
        .limit(50),
      // Recently terminalized VTIDs (last 24h) — autonomy throughput signal.
      sb
        .from('vtid_ledger')
        .select('vtid, title, terminal_outcome, updated_at')
        .eq('is_terminal', true)
        .gte('updated_at', new Date(Date.now() - 24 * 3600_000).toISOString())
        .order('updated_at', { ascending: false })
        .limit(20),
    ]);
    const findings = findingsRes.data ?? [];
    const heals = healsRes.data ?? [];
    const executions = execsRes.data ?? [];
    const contracts = contractsRes.data ?? [];
    const terminalized = (terminalizedRes.data ?? []) as Array<{
      vtid: string; title: string | null; terminal_outcome: string | null; updated_at: string;
    }>;

    // Reuse the Command Hub Pulse normalizer/sorter when importable.
    let topTitles: string[] = [];
    let severityCounts = { critical: 0, warning: 0, info: 0 };
    try {
      const pulseModule = await import('../../routes/autonomy-pulse');
      type Aggregate = typeof pulseModule.aggregatePulse;
      const items = pulseModule.aggregatePulse(
        findings as unknown as Parameters<Aggregate>[0],
        heals as unknown as Parameters<Aggregate>[1],
        executions as unknown as Parameters<Aggregate>[2],
        contracts as unknown as Parameters<Aggregate>[3],
      );
      severityCounts = {
        critical: items.filter((i) => i.severity === 'critical').length,
        warning: items.filter((i) => i.severity === 'warning').length,
        info: items.filter((i) => i.severity === 'info').length,
      };
      topTitles = items.slice(0, 3).map((i) => `${i.title} (${i.severity})`);
    } catch {
      /* aggregation unavailable — raw counts below still speak */
    }

    const total = findings.length + heals.length + executions.length + contracts.length;
    const succeeded = terminalized.filter((t) => t.terminal_outcome === 'success').length;
    const text =
      `Autonomy pulse: ${total} open item${total === 1 ? '' : 's'} — ` +
      `${findings.length} pending findings, ${heals.length} pending heals, ` +
      `${executions.length} executions in flight, ${contracts.length} failing contracts` +
      (severityCounts.critical + severityCounts.warning + severityCounts.info > 0
        ? ` (${severityCounts.critical} critical, ${severityCounts.warning} warning)`
        : '') +
      `. ${terminalized.length} VTIDs terminalized in the last 24 hours (${succeeded} succeeded).` +
      (topTitles.length ? ` Top attention items: ${topTitles.join('. ')}.` : '');
    return {
      ok: true,
      result: {
        counts: {
          findings: findings.length,
          heals: heals.length,
          executions: executions.length,
          contracts: contracts.length,
          total,
          ...severityCounts,
        },
        terminalized_24h: terminalized.length,
        terminalized_success_24h: succeeded,
        top_items: topTitles,
      },
      text,
    };
  } catch (err) {
    return { ok: false, error: `dev_get_autonomy_pulse failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// dev_list_agents — agents_registry with the same heartbeat decay logic
// routes/agents-registry.ts applies at read time
// ---------------------------------------------------------------------------

interface AgentRow {
  agent_id: string;
  display_name: string | null;
  tier: 'service' | 'embedded' | 'scheduled' | string;
  status: string | null;
  last_heartbeat_at: string | null;
  llm_provider: string | null;
}

/** Read-time status decay — mirrors deriveStatus() in routes/agents-registry.ts. */
export function deriveAgentStatus(row: AgentRow): string {
  const base = row.status ?? 'unknown';
  if (!row.last_heartbeat_at) return base;
  const age = Date.now() - new Date(row.last_heartbeat_at).getTime();
  if (row.tier === 'embedded') return base;
  if (row.tier === 'scheduled') {
    if (age > 24 * 3600_000) return 'down';
    if (age > 6 * 3600_000) return 'degraded';
    return base;
  }
  if (base === 'healthy') {
    if (age > 5 * 60_000) return 'down';
    if (age > 2 * 60_000) return 'degraded';
  }
  return base;
}

export const dev_list_agents: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const tier = String(args.tier ?? '').trim().toLowerCase();
  try {
    let q = sb
      .from('agents_registry')
      .select('agent_id, display_name, tier, status, last_heartbeat_at, llm_provider')
      .order('tier', { ascending: true })
      .order('agent_id', { ascending: true });
    if (tier) q = q.eq('tier', tier);
    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    const rows = ((data ?? []) as AgentRow[]).map((r) => ({ ...r, derived_status: deriveAgentStatus(r) }));
    if (rows.length === 0) {
      return { ok: true, result: { agents: [] }, text: 'The agent registry is empty.' };
    }
    const counts = {
      total: rows.length,
      healthy: rows.filter((r) => r.derived_status === 'healthy').length,
      degraded: rows.filter((r) => r.derived_status === 'degraded').length,
      down: rows.filter((r) => r.derived_status === 'down').length,
      unknown: rows.filter((r) => !['healthy', 'degraded', 'down'].includes(r.derived_status)).length,
    };
    const problems = rows.filter((r) => r.derived_status === 'down' || r.derived_status === 'degraded');
    const spoken = [...problems, ...rows.filter((r) => !problems.includes(r))].slice(0, 5);
    const lines = spoken.map((r) => {
      const hb = r.last_heartbeat_at ? `, heartbeat ${relAge(r.last_heartbeat_at)}` : '';
      return `${r.display_name || r.agent_id} (${r.tier}) — ${r.derived_status}${hb}`;
    });
    const head = `${counts.total} agents: ${counts.healthy} healthy, ${counts.degraded} degraded, ${counts.down} down.`;
    return { ok: true, result: { counts, agents: rows }, text: `${head} ${lines.join('. ')}` };
  } catch (err) {
    return { ok: false, error: `dev_list_agents failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const DEVELOPER_TOOL_HANDLERS: Record<string, Handler> = {
  dev_list_vtids,
  dev_get_vtid_status,
  dev_list_pending_approvals,
  dev_count_approvals,
  dev_approve_pr,
  dev_reject_pr,
  dev_list_voice_sessions,
  dev_list_routines,
  dev_get_routine_detail,
  dev_list_active_healing,
  dev_get_autonomy_pulse,
  dev_list_agents,
};

export const DEVELOPER_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'dev_list_vtids',
    description: [
      'DEVELOPER ONLY. List recent VTID tasks from the ledger (id, title, status).',
      'Call when the developer asks: "what are the latest VTIDs", "show open tasks",',
      '"welche VTIDs laufen gerade", "zeig mir die letzten Tasks".',
      'Optionally filter by status (scheduled, in_progress, completed, pending, blocked, cancelled).',
      'Speak each VTID id with its title and status.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional status filter: scheduled, in_progress, completed, pending, blocked, cancelled.' },
        limit: { type: 'integer', description: 'Max rows, 1-20. Use 5 unless the developer asks for more.' },
      },
    },
  },
  {
    name: 'dev_get_vtid_status',
    description: [
      'DEVELOPER ONLY. Get one VTID task by id — status, spec status, terminal state, claim.',
      'Call when the developer asks: "what is the status of VTID 1234", "is 2782 done",',
      '"wie steht es um VTID 1234", "ist die Task fertig".',
      'Accepts loose ids: "VTID-01234", "vtid 1234" or just "1234".',
      'Speak the title, status, spec status and whether it is terminal.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'VTID reference, e.g. "VTID-01234" or "1234".' },
      },
      required: ['vtid'],
    },
  },
  {
    name: 'dev_list_pending_approvals',
    description: [
      'DEVELOPER ONLY. List PRs/actions waiting in the approvals queue (same queue as the Command Hub approvals view).',
      'Call when the developer asks: "what is waiting for approval", "any PRs to approve",',
      '"was wartet auf Freigabe", "gibt es offene Approvals".',
      'Speak VTID, title, PR number and checks status for each item; then offer to approve or reject.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max items, 1-20. Use 5 unless asked for more.' },
      },
    },
  },
  {
    name: 'dev_count_approvals',
    description: [
      'DEVELOPER ONLY. Count how many items are pending approval.',
      'Call when the developer asks: "how many approvals are pending",',
      '"wie viele Freigaben stehen an". Speak just the number.',
    ].join('\n'),
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_approve_pr',
    description: [
      'DEVELOPER ONLY. Approve a queued approval — merges its PR via the governed pipeline.',
      'Call when the developer says: "approve VTID 1234", "merge that PR", "gib 1234 frei".',
      'TWO-STEP: first call WITHOUT confirm to get the confirmation text, read it to the',
      'developer, and only after an explicit yes call again with confirm=true.',
      'Identify the item by vtid (preferred, from dev_list_pending_approvals) or approval_id.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'VTID of the queued item, e.g. "VTID-01234".' },
        approval_id: { type: 'string', description: 'Exact approval id (appr_VTID-XXXXX_hash) if known.' },
        confirm: { type: 'boolean', description: 'Set true ONLY after the developer explicitly confirmed.' },
      },
    },
  },
  {
    name: 'dev_reject_pr',
    description: [
      'DEVELOPER ONLY. Reject a queued approval and record why.',
      'Call when the developer says: "reject VTID 1234 because ...", "lehne 1234 ab, weil ...".',
      'A reason is REQUIRED — ask for one if the developer did not give it.',
      'TWO-STEP: first call WITHOUT confirm, read the confirmation back, then call',
      'again with confirm=true after an explicit yes.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'VTID of the queued item.' },
        approval_id: { type: 'string', description: 'Exact approval id if known.' },
        reason: { type: 'string', description: 'Why it is being rejected. Required.' },
        confirm: { type: 'boolean', description: 'Set true ONLY after the developer explicitly confirmed.' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'dev_list_voice_sessions',
    description: [
      'DEVELOPER ONLY. List recent ORB voice sessions from the Voice Lab (who, when, duration, turns).',
      'Call when the developer asks: "who used voice recently", "any active voice sessions",',
      '"welche Voice-Sessions liefen zuletzt", "läuft gerade eine Session".',
      'Optionally filter to active or ended sessions. Speak user, status and start time.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter: active, ended, or all (all when omitted).' },
        limit: { type: 'integer', description: 'Max sessions, 1-10. Use 5 unless asked for more.' },
      },
    },
  },
  {
    name: 'dev_list_routines',
    description: [
      'DEVELOPER ONLY. List the daily Claude routines with last-run status.',
      'Call when the developer asks: "how are the routines doing", "did the nightly routines run",',
      '"wie laufen die Routinen", "sind die Routinen durchgelaufen".',
      'Speak failing routines first, then the rest, with last run result and age.',
    ].join('\n'),
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_get_routine_detail',
    description: [
      'DEVELOPER ONLY. Detail one routine plus its last runs.',
      'Call when the developer asks: "what happened in the morning-report routine",',
      '"warum ist die Routine fehlgeschlagen", "zeig mir die letzten Läufe von X".',
      'Accepts the routine name or a close spoken match. Speak schedule, last status and recent runs.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Routine name or display name (fuzzy match allowed).' },
        runs_limit: { type: 'integer', description: 'How many recent runs to include, 1-10. Use 5.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'dev_list_active_healing',
    description: [
      'DEVELOPER ONLY. Show self-healing work currently in flight: active healing VTIDs and pending diagnoses.',
      'Call when the developer asks: "is self-healing doing anything", "any heals running",',
      '"läuft gerade ein Self-Healing", "gibt es offene Heilungen".',
      'Speak counts plus the endpoints/VTIDs involved.',
    ].join('\n'),
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_get_autonomy_pulse',
    description: [
      'DEVELOPER ONLY. One-shot autonomy status: pending findings, pending heals, executions',
      'in flight, failing test contracts, and VTIDs terminalized in the last 24 hours.',
      'Call when the developer asks: "give me the autonomy pulse", "how is the autopilot doing",',
      '"wie steht die Autonomie", "was macht der Autopilot gerade".',
      'Speak the counts and the top attention items.',
    ].join('\n'),
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_list_agents',
    description: [
      'DEVELOPER ONLY. List registered agents with heartbeat-derived health (healthy/degraded/down).',
      'Call when the developer asks: "are all agents up", "which agents are down",',
      '"sind alle Agenten gesund", "welche Agents laufen".',
      'Optionally filter by tier (service, embedded, scheduled). Speak problem agents first.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        tier: { type: 'string', description: 'Optional tier filter: service, embedded, scheduled.' },
      },
    },
  },
];
