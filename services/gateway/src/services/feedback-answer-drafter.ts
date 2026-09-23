/**
 * VTID-04384 — every support question the auto-triage routes to Sage gets a
 * real drafted answer for the supervisor to review, not only when someone
 * clicks "Generate answer".
 *
 * The SQL auto-triage (pg_cron `feedback-auto-triage`) moves a support
 * question to `answer_ready` with a PLACEHOLDER answer ("**Sage auto-draft
 * (placeholder)**"). Until now only the manual endpoints replaced it with a
 * Sage draft, so the supervisor queue filled with placeholders.
 *
 * `draftPlaceholderAnswersTick` is the sibling of the spec drafter
 * (VTID-04311): it runs inside the executor tick, throttled, replaces a
 * placeholder answer with `llmDraftSageAnswer` (the `triage` routing stage —
 * Bedrock primary, never Google), counts attempts, stops after
 * MAX_ANSWER_DRAFT_ATTEMPTS, and claims the ticket first so the prod and
 * staging gateways (one shared database) never draft the same ticket twice.
 *
 * It NEVER sends the answer to the member. Sending stays a human action
 * (feedback-actions / tenant-specialists "send answer"). A failed draft leaves
 * the placeholder in place. FEEDBACK_ANSWER_DRAFT_ENABLED=false disables it.
 *
 * Not in scope: support tickets filed from Support → Contact
 * (`surface='support'`) never reach `answer_ready` — the auto-triage keeps
 * them in the human-only queue on purpose (migration 20260604123000).
 */
import { llmDraftSageAnswer } from './feedback-llm-resolvers';
import { isPlaceholderSpec } from './feedback-spec-drafter';

const LOG_PREFIX = '[feedback-answer-drafter]';
export const MAX_ANSWER_DRAFT_ATTEMPTS = 3;
export const ANSWER_DRAFTS_PER_TICK = 3;
const CLAIM_STALE_MS = 10 * 60_000;

export function isAnswerDraftingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FEEDBACK_ANSWER_DRAFT_ENABLED !== 'false';
}

export function answerDraftIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.FEEDBACK_ANSWER_DRAFT_INTERVAL_MS || '', 10);
  return Number.isFinite(n) && n >= 30_000 ? n : 5 * 60_000;
}

/** A placeholder answer is one the auto-triage or an LLM fallback wrote. */
export function isPlaceholderAnswer(answer: string | null | undefined): boolean {
  return isPlaceholderSpec(answer);
}

interface SupaConfig { url: string; key: string }

interface AnswerTicketRow {
  id: string;
  ticket_number: string | null;
  kind: string;
  status: string;
  draft_answer_md: string | null;
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

export type AnswerDraftFn = typeof llmDraftSageAnswer;

export interface AnswerDraftTickResult { drafted: number; failed: number; skipped: number }

let lastRunAt = 0;
/** Reset the throttle (tests). */
export function resetAnswerDraftThrottle(): void { lastRunAt = 0; }

function headers(s: SupaConfig, prefer = 'return=minimal'): Record<string, string> {
  return { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json', Prefer: prefer };
}

/** Guarded on answer_ready, so a human send / reject in between wins. */
async function patchTicket(s: SupaConfig, id: string, body: Record<string, unknown>): Promise<boolean> {
  const r = await fetch(`${s.url}/rest/v1/feedback_tickets?id=eq.${id}&status=eq.answer_ready`, {
    method: 'PATCH', headers: headers(s, 'return=representation'), body: JSON.stringify(body),
  });
  if (!r.ok) return false;
  const rows = (await r.json().catch(() => [])) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

/** One throttled pass. Never throws. */
export async function draftPlaceholderAnswersTick(
  s: SupaConfig,
  deps: { draft?: AnswerDraftFn; now?: () => number; env?: NodeJS.ProcessEnv; force?: boolean } = {},
): Promise<AnswerDraftTickResult> {
  const out: AnswerDraftTickResult = { drafted: 0, failed: 0, skipped: 0 };
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  if (!isAnswerDraftingEnabled(env)) return out;
  if (!deps.force && now() - lastRunAt < answerDraftIntervalMs(env)) return out;
  lastRunAt = now();
  const draft = deps.draft ?? llmDraftSageAnswer;

  try {
    const r = await fetch(
      `${s.url}/rest/v1/feedback_tickets?kind=eq.support_question&status=eq.answer_ready&draft_answer_md=ilike.*placeholder*`
        + '&select=id,ticket_number,kind,status,draft_answer_md,raw_transcript,intake_messages,structured_fields,classifier_meta,screen_path,app_version,vitana_id,priority,supervisor_notes'
        + `&order=created_at.asc&limit=${ANSWER_DRAFTS_PER_TICK * 3}`,
      { headers: headers(s) },
    );
    if (!r.ok) return out;
    const rows = ((await r.json().catch(() => [])) as AnswerTicketRow[])
      .filter((t) => isPlaceholderAnswer(t.draft_answer_md));

    for (const t of rows) {
      if (out.drafted + out.failed >= ANSWER_DRAFTS_PER_TICK) break;
      const meta = { ...(t.classifier_meta || {}) } as Record<string, unknown>;
      const attempts = Number(meta.answer_draft_attempts || 0);
      const claimedAt = typeof meta.answer_draft_claimed_at === 'string' ? Date.parse(meta.answer_draft_claimed_at) : NaN;
      if (attempts >= MAX_ANSWER_DRAFT_ATTEMPTS || (Number.isFinite(claimedAt) && now() - claimedAt < CLAIM_STALE_MS)) {
        out.skipped++;
        continue;
      }
      const claimMeta = { ...meta, answer_draft_claimed_at: new Date(now()).toISOString(), answer_draft_attempts: attempts + 1 };
      if (!(await patchTicket(s, t.id, { classifier_meta: claimMeta }))) { out.skipped++; continue; }

      const result = await draft(t, { supervisorInstructions: t.supervisor_notes ?? undefined }).catch(() => null);
      if (result && result.provider === 'llm' && !isPlaceholderAnswer(result.markdown)) {
        const ok = await patchTicket(s, t.id, {
          draft_answer_md: result.markdown,
          classifier_meta: {
            ...claimMeta,
            answer_draft_claimed_at: null,
            answer_drafted_by: 'sage-llm',
            answer_drafted_at: new Date(now()).toISOString(),
          },
        });
        if (ok) { out.drafted++; continue; }
      }
      await patchTicket(s, t.id, { classifier_meta: { ...claimMeta, answer_draft_claimed_at: null } });
      out.failed++;
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} tick error:`, err instanceof Error ? err.message : err);
  }
  return out;
}
