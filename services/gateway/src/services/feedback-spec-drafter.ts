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
  deps: { draft?: DraftFn; now?: () => number; env?: NodeJS.ProcessEnv; force?: boolean } = {},
): Promise<{ drafted: number; failed: number; skipped: number }> {
  const out = { drafted: 0, failed: 0, skipped: 0 };
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  if (!isSpecDraftingEnabled(env)) return out;
  if (!deps.force && now() - lastRunAt < specDraftIntervalMs(env)) return out;
  lastRunAt = now();
  const draft = deps.draft ?? llmDraftDevonSpec;

  try {
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
        if (ok) { out.drafted++; continue; }
      }
      await patchTicket(s, t.id, { classifier_meta: { ...claimMeta, spec_draft_claimed_at: null } });
      out.failed++;
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} tick error:`, err instanceof Error ? err.message : err);
  }
  return out;
}
