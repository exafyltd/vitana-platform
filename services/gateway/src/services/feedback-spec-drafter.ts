/**
 * VTID-04311 — real specs for bug / ux_issue tickets, and no placeholder
 * spec ever reaches Dev Autopilot.
 *
 * The SQL auto-triage (pg_cron `feedback-auto-triage`, migration
 * 20260429160000) moves a triaged bug to `spec_ready` with a PLACEHOLDER
 * spec ("# Devon auto-draft spec (placeholder)"), and the on-demand LLM
 * draft falls back to another placeholder ("… (LLM unavailable,
 * placeholder)") when the router fails. Activate / Approve & Fix dispatched
 * any non-empty spec, so a placeholder could become an autopilot plan.
 *
 * Two parts:
 *   - `isPlaceholderSpec` — the bridge refuses to dispatch one.
 *   - `draftPlaceholderSpecsTick` — runs inside the executor tick, throttled,
 *     and replaces placeholder specs with a real Devon draft through the
 *     `triage` routing stage (llmDraftDevonSpec — Bedrock primary, never
 *     Google). A failed draft leaves the placeholder in place (so dispatch
 *     keeps refusing) and counts the attempt; after MAX_ATTEMPTS it stops.
 *
 * Prod and staging share one database; a claim stamp in classifier_meta
 * keeps the two gateways from drafting the same ticket at once.
 *
 * VTID-04333 (owner decision, brief §3.5.1): every bug / ux_issue ticket with
 * a real spec is dispatched to Dev Autopilot without an "Approve & Fix"
 * click. `autoDispatchReadyTickets` runs in the same throttled pass — first
 * the tickets this pass just drafted, then any other spec_ready ticket with a
 * non-placeholder spec and no linked finding — and calls the one
 * approve-and-dispatch path (approveAndDispatchTicket) as actor
 * 'auto-dispatch'. Gated by FEEDBACK_AUTO_DISPATCH_ENABLED (exact string
 * 'true'; anything else is off — pinned on staging only). It stays behind the
 * kill switch (checked here before any VTID is allocated, and again by the
 * safety gate inside the bridge), is capped at
 * FEEDBACK_AUTO_DISPATCH_PER_TICK tickets per pass (default 2), retries a
 * refused ticket at most MAX_AUTO_DISPATCH_ATTEMPTS times, and never touches
 * another kind. The PR-approval hold on the execution is unchanged.
 */
import { llmDraftDevonSpec } from './feedback-llm-resolvers';

const LOG_PREFIX = '[feedback-spec-drafter]';
const PLACEHOLDER_RE = /\(placeholder\)|LLM unavailable, placeholder/i;
export const MAX_DRAFT_ATTEMPTS = 3;
export const DRAFTS_PER_TICK = 3;
const CLAIM_STALE_MS = 10 * 60_000;

export function isPlaceholderSpec(spec: string | null | undefined): boolean {
  const s = (spec ?? '').trim();
  if (!s) return true;
  return PLACEHOLDER_RE.test(s.split('\n').slice(0, 3).join('\n'));
}

export function isSpecDraftingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FEEDBACK_SPEC_DRAFT_ENABLED !== 'false';
}

/** VTID-04333: exact string 'true' enables auto-dispatch; anything else is off. */
export function isAutoDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FEEDBACK_AUTO_DISPATCH_ENABLED === 'true';
}

export const MAX_AUTO_DISPATCH_ATTEMPTS = 3;
const AUTO_DISPATCH_KINDS = new Set(['bug', 'ux_issue']);
const AUTO_DISPATCH_EVENT_FALLBACK_VTID = 'VTID-04333';

export function autoDispatchPerTick(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.FEEDBACK_AUTO_DISPATCH_PER_TICK || '', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 10) : 2;
}

export function specDraftIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.FEEDBACK_SPEC_DRAFT_INTERVAL_MS || '', 10);
  return Number.isFinite(n) && n >= 30_000 ? n : 5 * 60_000;
}

interface SupaConfig { url: string; key: string }

interface TicketRow {
  id: string;
  ticket_number: string | null;
  kind: string;
  status: string;
  spec_md: string | null;
  raw_transcript: string | null;
  intake_messages: Array<{ agent?: string; role: string; content: string }> | null;
  structured_fields: Record<string, unknown> | null;
  classifier_meta: Record<string, unknown> | null;
  screen_path: string | null;
  app_version: string | null;
  vitana_id: string | null;
  priority: string | null;
  supervisor_notes: string | null;
}

export type DraftFn = typeof llmDraftDevonSpec;
export type DispatchFn = (ticketId: string, approvedBy: string) => Promise<{
  ok: boolean; error?: string; vtid?: string; execution_id?: string; recommendation_id?: string;
  violations?: Array<{ code: string; message: string }>;
}>;

export interface DraftTickResult {
  drafted: number;
  failed: number;
  skipped: number;
  /** VTID-04333 */
  dispatched: number;
  dispatch_failed: number;
}

let lastRunAt = 0;
/** Reset the throttle (tests). */
export function resetSpecDraftThrottle(): void { lastRunAt = 0; }

function headers(s: SupaConfig, prefer = 'return=minimal'): Record<string, string> {
  return { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json', Prefer: prefer };
}

async function patchTicket(s: SupaConfig, id: string, body: Record<string, unknown>): Promise<boolean> {
  const r = await fetch(`${s.url}/rest/v1/feedback_tickets?id=eq.${id}&status=eq.spec_ready`, {
    method: 'PATCH', headers: headers(s, 'return=representation'), body: JSON.stringify(body),
  });
  if (!r.ok) return false;
  const rows = (await r.json().catch(() => [])) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * One throttled pass. Returns counts for the caller's log line. Never throws.
 */
export async function draftPlaceholderSpecsTick(
  s: SupaConfig,
  deps: { draft?: DraftFn; dispatch?: DispatchFn; now?: () => number; env?: NodeJS.ProcessEnv; force?: boolean } = {},
): Promise<DraftTickResult> {
  const out: DraftTickResult = { drafted: 0, failed: 0, skipped: 0, dispatched: 0, dispatch_failed: 0 };
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const drafting = isSpecDraftingEnabled(env);
  const autoDispatch = isAutoDispatchEnabled(env);
  if (!drafting && !autoDispatch) return out;
  if (!deps.force && now() - lastRunAt < specDraftIntervalMs(env)) return out;
  lastRunAt = now();
  const draft = deps.draft ?? llmDraftDevonSpec;
  const draftedIds: string[] = [];

  if (drafting) try {
    const r = await fetch(
      `${s.url}/rest/v1/feedback_tickets?kind=in.(bug,ux_issue)&status=eq.spec_ready&spec_md=ilike.*placeholder*`
        + '&select=id,ticket_number,kind,status,spec_md,raw_transcript,intake_messages,structured_fields,classifier_meta,screen_path,app_version,vitana_id,priority,supervisor_notes'
        + `&order=created_at.asc&limit=${DRAFTS_PER_TICK * 3}`,
      { headers: headers(s) },
    );
    if (!r.ok) return out;
    const rows = ((await r.json().catch(() => [])) as TicketRow[]).filter((t) => isPlaceholderSpec(t.spec_md));

    for (const t of rows) {
      if (out.drafted + out.failed >= DRAFTS_PER_TICK) break;
      const meta = { ...(t.classifier_meta || {}) } as Record<string, unknown>;
      const attempts = Number(meta.spec_draft_attempts || 0);
      const claimedAt = typeof meta.spec_draft_claimed_at === 'string' ? Date.parse(meta.spec_draft_claimed_at) : NaN;
      if (attempts >= MAX_DRAFT_ATTEMPTS || (Number.isFinite(claimedAt) && now() - claimedAt < CLAIM_STALE_MS)) {
        out.skipped++;
        continue;
      }
      // Claim before the (slow) model call.
      const claimMeta = { ...meta, spec_draft_claimed_at: new Date(now()).toISOString(), spec_draft_attempts: attempts + 1 };
      if (!(await patchTicket(s, t.id, { classifier_meta: claimMeta }))) { out.skipped++; continue; }

      const result = await draft(t, { supervisorInstructions: t.supervisor_notes ?? undefined }).catch(() => null);
      if (result && result.provider === 'llm' && !isPlaceholderSpec(result.markdown)) {
        const ok = await patchTicket(s, t.id, {
          spec_md: result.markdown,
          classifier_meta: { ...claimMeta, spec_draft_claimed_at: null, spec_drafted_by: 'devon-llm', spec_drafted_at: new Date(now()).toISOString() },
        });
        if (ok) { out.drafted++; draftedIds.push(t.id); continue; }
      }
      await patchTicket(s, t.id, { classifier_meta: { ...claimMeta, spec_draft_claimed_at: null } });
      out.failed++;
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} tick error:`, err instanceof Error ? err.message : err);
  }

  if (autoDispatch) {
    const d = await autoDispatchReadyTickets(s, { draftedIds, dispatch: deps.dispatch, now, env });
    out.dispatched = d.dispatched;
    out.dispatch_failed = d.failed;
  }
  return out;
}

interface DispatchCandidate {
  id: string;
  ticket_number: string | null;
  kind: string;
  status: string;
  spec_md: string | null;
  classifier_meta: Record<string, unknown> | null;
  linked_finding_id: string | null;
  linked_vtid: string | null;
}

const CANDIDATE_SELECT = 'id,ticket_number,kind,status,spec_md,classifier_meta,linked_finding_id,linked_vtid';

/** Fail closed: an unreadable config counts as an armed kill switch. */
async function killSwitchArmed(s: SupaConfig): Promise<boolean> {
  try {
    const r = await fetch(`${s.url}/rest/v1/dev_autopilot_config?id=eq.1&select=kill_switch&limit=1`, { headers: headers(s) });
    if (!r.ok) return true;
    const rows = (await r.json().catch(() => [])) as Array<{ kill_switch?: boolean }>;
    return !rows[0] || rows[0].kill_switch !== false;
  } catch {
    return true;
  }
}

async function emitAutoDispatchBlocked(t: DispatchCandidate, error: string, attempt: number, codes: string[]): Promise<void> {
  try {
    const { emitOasisEvent } = await import('./oasis-event-service');
    await emitOasisEvent({
      vtid: t.linked_vtid && /^VTID-\d{4,5}$/.test(t.linked_vtid) ? t.linked_vtid : AUTO_DISPATCH_EVENT_FALLBACK_VTID,
      type: 'feedback.ticket.auto_dispatch_blocked',
      source: 'feedback-spec-drafter',
      status: 'warning',
      message: `Auto-dispatch of feedback ticket ${t.ticket_number ?? t.id} refused (attempt ${attempt}/${MAX_AUTO_DISPATCH_ATTEMPTS}): ${error.slice(0, 200)}`,
      payload: {
        ticket_id: t.id, ticket_number: t.ticket_number, linked_vtid: t.linked_vtid,
        attempt, max_attempts: MAX_AUTO_DISPATCH_ATTEMPTS, error: error.slice(0, 500), violation_codes: codes,
      },
    });
  } catch { /* non-blocking */ }
}

/**
 * VTID-04333: dispatch spec_ready bug / ux_issue tickets whose spec is real.
 * Exported for tests; called from draftPlaceholderSpecsTick. Never throws.
 */
export async function autoDispatchReadyTickets(
  s: SupaConfig,
  opts: { draftedIds?: string[]; dispatch?: DispatchFn; now?: () => number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ dispatched: number; failed: number; skipped: number }> {
  const res = { dispatched: 0, failed: 0, skipped: 0 };
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  if (!isAutoDispatchEnabled(env)) return res;
  try {
    if (await killSwitchArmed(s)) {
      console.log(`${LOG_PREFIX} auto-dispatch skipped: kill switch armed (or config unreadable)`);
      return res;
    }
    const cap = autoDispatchPerTick(env);
    const base = `${s.url}/rest/v1/feedback_tickets?kind=in.(bug,ux_issue)&status=eq.spec_ready&linked_finding_id=is.null`;
    const lists: DispatchCandidate[][] = [];
    const drafted = (opts.draftedIds ?? []).filter((id) => /^[0-9a-z-]{1,36}$/i.test(id));
    if (drafted.length > 0) {
      const r = await fetch(`${base}&id=in.(${drafted.join(',')})&select=${CANDIDATE_SELECT}`, { headers: headers(s) });
      if (r.ok) lists.push((await r.json().catch(() => [])) as DispatchCandidate[]);
    }
    const sweep = await fetch(
      `${base}&spec_md=not.ilike.*placeholder*&select=${CANDIDATE_SELECT}&order=created_at.asc&limit=${cap * 5}`,
      { headers: headers(s) },
    );
    if (sweep.ok) lists.push((await sweep.json().catch(() => [])) as DispatchCandidate[]);

    const seen = new Set<string>();
    const candidates = lists.flat().filter((t) => {
      if (!t || seen.has(t.id)) return false;
      seen.add(t.id);
      return AUTO_DISPATCH_KINDS.has(t.kind) && t.status === 'spec_ready' && !t.linked_finding_id && !isPlaceholderSpec(t.spec_md);
    });

    const dispatch: DispatchFn = opts.dispatch ?? (async (id, actor) => {
      const { approveAndDispatchTicket } = await import('./feedback-execution-bridge');
      return approveAndDispatchTicket(id, actor);
    });

    for (const t of candidates) {
      if (res.dispatched + res.failed >= cap) break;
      const meta = { ...(t.classifier_meta || {}) } as Record<string, unknown>;
      const attempts = Number(meta.auto_dispatch_attempts || 0);
      const claimedAt = typeof meta.auto_dispatch_claimed_at === 'string' ? Date.parse(meta.auto_dispatch_claimed_at) : NaN;
      if (attempts >= MAX_AUTO_DISPATCH_ATTEMPTS || (Number.isFinite(claimedAt) && now() - claimedAt < CLAIM_STALE_MS)) {
        res.skipped++;
        continue;
      }
      // Claim + count the attempt before the (slow) dispatch, guarded on
      // spec_ready so the other gateway / a human click cannot double-run it.
      const claimMeta = { ...meta, auto_dispatch_attempts: attempts + 1, auto_dispatch_claimed_at: new Date(now()).toISOString() };
      if (!(await patchTicket(s, t.id, { classifier_meta: claimMeta }))) { res.skipped++; continue; }

      let d: Awaited<ReturnType<DispatchFn>>;
      try {
        d = await dispatch(t.id, 'auto-dispatch');
      } catch (err) {
        d = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (d.ok) {
        res.dispatched++;
        console.log(`${LOG_PREFIX} auto-dispatched ${t.ticket_number ?? t.id} → ${d.vtid ?? 'no-vtid'} execution=${(d.execution_id ?? '').slice(0, 8)}`);
        continue;
      }
      res.failed++;
      const error = d.error ?? 'dispatch refused';
      await patchTicket(s, t.id, {
        classifier_meta: {
          ...claimMeta,
          auto_dispatch_claimed_at: null,
          auto_dispatch_last_error: error.slice(0, 500),
          auto_dispatch_last_at: new Date(now()).toISOString(),
        },
      });
      await emitAutoDispatchBlocked(t, error, attempts + 1, (d.violations ?? []).map((v) => v.code));
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} auto-dispatch error:`, err instanceof Error ? err.message : err);
  }
  return res;
}
