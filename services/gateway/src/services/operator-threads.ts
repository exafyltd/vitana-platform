/**
 * VTID-04022 (operator agent W4b): server-side Operator Console threads.
 *
 * Gap analysis §4.3 "Memory that actually accrues". Until now the console's
 * transcript lived in the browser (localStorage, VTID-03822) and its memory
 * recall (VTID-03892) ran against the raw current message only. This module:
 *
 *   recordOperatorTurn   — after every /api/v1/operator/chat turn, upsert the
 *                          thread row and append the user + assistant (+ tool)
 *                          messages. Fire-and-forget from the route.
 *   maybeSummarizeThread — every OPERATOR_THREAD_SUMMARY_EVERY turns, rewrite
 *                          the thread's rolling summary from its recent
 *                          messages via the `memory` routing stage (Bedrock
 *                          primary, DeepSeek fallback — never Google).
 *   getThreadSummary     — read the summary so the turn's dev_agent_memory
 *                          recall can run against summary + current message
 *                          (buildRecallQuery), not the raw message alone.
 *
 * Everything is fail-open: a missing table (the migration ships as a file
 * and is applied on the owner's go), a Supabase error, or a router failure
 * logs once and never blocks or degrades the chat reply. Gated on
 * OPERATOR_THREADS_ENABLED=true (default off).
 */

import { callViaRouter } from './llm-router';

const LOG_PREFIX = '[operator-threads]';
export const DEFAULT_SUMMARY_EVERY = 10;
export const SUMMARY_MESSAGE_WINDOW = 30;
export const SUMMARY_MAX_CHARS = 1_600;
export const MESSAGE_MAX_CHARS = 6_000;
export const RECALL_SUMMARY_MAX_CHARS = 1_200;
export const TITLE_MAX_CHARS = 80;

export function isOperatorThreadsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPERATOR_THREADS_ENABLED === 'true';
}

export function summaryEvery(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.OPERATOR_THREAD_SUMMARY_EVERY || '', 10);
  return Number.isFinite(n) && n >= 2 ? n : DEFAULT_SUMMARY_EVERY;
}

interface SupaConfig { url: string; key: string }

function getSupa(): SupaConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  return url && key ? { url, key } : null;
}

let missingTableWarned = false;

async function rest<T>(s: SupaConfig, path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  try {
    const res = await fetch(`${s.url}/rest/v1/${path}`, {
      method: init.method || 'GET',
      headers: {
        apikey: s.key,
        Authorization: `Bearer ${s.key}`,
        'Content-Type': 'application/json',
        Prefer: init.prefer || (init.method && init.method !== 'GET' ? 'return=minimal' : 'return=representation'),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 404 || /relation .* does not exist|PGRST205/.test(text)) {
        if (!missingTableWarned) {
          missingTableWarned = true;
          console.warn(`${LOG_PREFIX} operator_threads/operator_messages not found — apply supabase/migrations/20260917230000_vtid_04022_operator_threads.sql; recording nothing until then`);
        }
      }
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    if (res.status === 204) return { ok: true, status: 204 };
    const text = await res.text();
    return { ok: true, status: res.status, data: text ? (JSON.parse(text) as T) : undefined };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Reset the once-per-process warning (tests). */
export function resetOperatorThreadsWarning(): void { missingTableWarned = false; }

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function deriveThreadTitle(firstUserText: string): string {
  const line = (firstUserText || '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) || 'Operator thread';
  return line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS - 1)}…` : line;
}

export function clipMessage(text: string, max = MESSAGE_MAX_CHARS): string {
  const t = text || '';
  return t.length > max ? `${t.slice(0, max)}\n…[clipped]` : t;
}

/** Recall runs against the thread summary + the current message (§4.1/§4.3). */
export function buildRecallQuery(summary: string | null | undefined, text: string): string {
  const s = (summary || '').trim();
  if (!s) return text;
  const bounded = s.length > RECALL_SUMMARY_MAX_CHARS ? s.slice(0, RECALL_SUMMARY_MAX_CHARS) : s;
  return `Conversation so far: ${bounded}\n\nCurrent message: ${text}`;
}

export interface ThreadMessage { role: 'user' | 'assistant' | 'tool'; content: string; tool_name?: string | null; created_at?: string }

/** English instructions to the model — not user-facing text (CLAUDE.md §13b). */
export function buildSummaryPrompt(messages: ThreadMessage[], priorSummary: string | null | undefined): string {
  const transcript = messages
    .map((m) => `${m.role === 'tool' ? `tool(${m.tool_name || '?'})` : m.role}: ${clipMessage(m.content, 1_200).replace(/\s+/g, ' ')}`)
    .join('\n');
  return [
    'You maintain a rolling summary of an internal engineering operator conversation (the Vitana Command Hub Operator Console).',
    'Rewrite the summary so a future turn can pick the conversation up with no other context. Keep: the goal, decisions taken, VTIDs / PRs / services / files named, what was tried and what failed, and what is still open. Drop pleasantries and repetition.',
    `Hard limit: ${SUMMARY_MAX_CHARS} characters. Plain prose, no headings, English.`,
    priorSummary ? `\nPrevious summary:\n${priorSummary}` : '',
    `\nRecent messages (oldest first):\n${transcript}`,
    '\nWrite the new summary now.',
  ].join('\n');
}

export function shouldSummarize(turns: number, summaryTurns: number, every: number): boolean {
  return turns > 0 && turns % every === 0 && turns > summaryTurns;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface RecordTurnInput {
  threadId: string;
  identity?: { user_id?: string | null; tenant_id?: string | null; role?: string | null } | null;
  userText: string;
  reply: string;
  /** Tool calls the turn made, with a compact rendering of each result. */
  tools?: Array<{ name: string; result: string }>;
  meta?: Record<string, unknown>;
}

interface ThreadRow { id: string; turns: number; summary: string | null; summary_turns: number; title: string | null }

/**
 * Upsert the thread and append this turn's messages. Returns the thread's
 * new turn count (0 when disabled or unavailable) so the caller can decide
 * on summarisation. Never throws.
 */
export async function recordOperatorTurn(input: RecordTurnInput, env: NodeJS.ProcessEnv = process.env): Promise<{ recorded: boolean; turns: number }> {
  if (!isOperatorThreadsEnabled(env)) return { recorded: false, turns: 0 };
  const s = getSupa();
  if (!s) return { recorded: false, turns: 0 };
  try {
    const id = encodeURIComponent(input.threadId);
    const existing = await rest<ThreadRow[]>(s, `operator_threads?id=eq.${id}&select=id,turns,summary,summary_turns,title&limit=1`);
    if (!existing.ok) return { recorded: false, turns: 0 };
    const row = existing.data && existing.data[0];
    const now = new Date().toISOString();
    const turns = (row?.turns || 0) + 1;
    const write = row
      ? await rest(s, `operator_threads?id=eq.${id}`, { method: 'PATCH', body: { turns, updated_at: now, last_message_at: now } })
      : await rest(s, 'operator_threads', {
        method: 'POST',
        body: {
          id: input.threadId,
          user_id: input.identity?.user_id || null,
          tenant_id: input.identity?.tenant_id || null,
          role: input.identity?.role || null,
          title: deriveThreadTitle(input.userText),
          turns,
          created_at: now,
          updated_at: now,
          last_message_at: now,
        },
      });
    if (!write.ok) return { recorded: false, turns: 0 };
    // VTID-04095: every object in a PostgREST bulk-insert array must carry the
    // exact same key set (PGRST102 "All object keys must match") — a
    // tool-role message with `tool_name` alongside user/assistant messages
    // without it fails the whole insert outright. `tool_name: null` on the
    // non-tool rows keeps every object's keys identical.
    const messages: Array<Record<string, unknown>> = [
      { thread_id: input.threadId, role: 'user', tool_name: null, content: clipMessage(input.userText), meta: input.meta || {} },
      ...(input.tools || []).map((t) => ({ thread_id: input.threadId, role: 'tool', tool_name: t.name, content: clipMessage(t.result, 2_000), meta: {} })),
      { thread_id: input.threadId, role: 'assistant', tool_name: null, content: clipMessage(input.reply), meta: input.meta || {} },
    ];
    const ins = await rest(s, 'operator_messages', { method: 'POST', body: messages });
    if (!ins.ok) console.warn(`${LOG_PREFIX} message insert failed (${ins.status}): ${ins.error}`);
    return { recorded: ins.ok, turns };
  } catch (err) {
    console.warn(`${LOG_PREFIX} recordOperatorTurn error:`, err instanceof Error ? err.message : err);
    return { recorded: false, turns: 0 };
  }
}

export async function getThreadSummary(threadId: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!isOperatorThreadsEnabled(env)) return null;
  const s = getSupa();
  if (!s) return null;
  const r = await rest<Array<{ summary: string | null }>>(s, `operator_threads?id=eq.${encodeURIComponent(threadId)}&select=summary&limit=1`);
  const summary = r.ok && r.data && r.data[0] ? r.data[0].summary : null;
  return summary && summary.trim() ? summary : null;
}

export type Summarizer = (prompt: string) => Promise<string | null>;

const routerSummarizer: Summarizer = async (prompt) => {
  const r = await callViaRouter('memory', prompt, { service: 'operator-threads', maxTokens: 600 });
  if (!r.ok || !r.text) {
    console.warn(`${LOG_PREFIX} summary generation failed via ${r.provider ?? 'router'}: ${r.error ?? 'empty'}`);
    return null;
  }
  return r.text.trim().slice(0, SUMMARY_MAX_CHARS);
};

/**
 * Rewrite the thread summary when `turns` hits the cadence. Never throws;
 * returns whether a summary was written.
 */
export async function maybeSummarizeThread(threadId: string, turns: number, opts: { summarize?: Summarizer; env?: NodeJS.ProcessEnv } = {}): Promise<boolean> {
  const env = opts.env || process.env;
  if (!isOperatorThreadsEnabled(env)) return false;
  const s = getSupa();
  if (!s) return false;
  try {
    const id = encodeURIComponent(threadId);
    const t = await rest<ThreadRow[]>(s, `operator_threads?id=eq.${id}&select=id,turns,summary,summary_turns,title&limit=1`);
    const row = t.ok && t.data && t.data[0];
    if (!row || !shouldSummarize(turns, row.summary_turns || 0, summaryEvery(env))) return false;
    const m = await rest<ThreadMessage[]>(s, `operator_messages?thread_id=eq.${id}&select=role,content,tool_name,created_at&order=created_at.desc&limit=${SUMMARY_MESSAGE_WINDOW}`);
    const messages = (m.ok && m.data ? m.data : []).slice().reverse();
    if (messages.length === 0) return false;
    const summary = await (opts.summarize || routerSummarizer)(buildSummaryPrompt(messages, row.summary));
    if (!summary) return false;
    const w = await rest(s, `operator_threads?id=eq.${id}`, { method: 'PATCH', body: { summary, summary_turns: turns, updated_at: new Date().toISOString() } });
    if (w.ok) console.log(`${LOG_PREFIX} thread ${threadId.slice(0, 8)} summarised at turn ${turns} (${summary.length} chars)`);
    return w.ok;
  } catch (err) {
    console.warn(`${LOG_PREFIX} maybeSummarizeThread error:`, err instanceof Error ? err.message : err);
    return false;
  }
}
