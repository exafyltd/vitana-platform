/**
 * VTID-04407 — end-of-thread handoff for developer memory.
 *
 * When an Operator Console thread goes quiet, the `memory` routing stage
 * writes one short handoff note — where the work stopped, what is still
 * open, what to do next — into dev_agent_memory (category 'handoff',
 * author_user_id = the thread's owner). The next morning the owner's pack
 * (morning-pack.ts) starts from it instead of from nothing.
 *
 * One live handoff per thread: a newer one supersedes the older
 * (superseded_by), and a thread whose latest handoff is already newer than
 * its last message is skipped, so the sweep is idempotent.
 *
 * Admin-facing, English by design: the reader is an engineer or an agent,
 * and the note is recalled into English prompts.
 */

import { callViaRouter } from '../llm-router';
import { getSupabase, supa } from '../dev-autopilot-execute';
import { writeDevMemory } from '../dev-agent-memory';

export const HANDOFF_IDLE_MINUTES = 60;
export const HANDOFF_LOOKBACK_HOURS = 26;
export const HANDOFF_MESSAGE_WINDOW = 30;
export const HANDOFF_MAX_INPUT_CHARS = 12_000;
export const HANDOFF_MAX_CHARS = 1_200;
export const HANDOFF_SWEEP_LIMIT = 40;

export const HANDOFF_SYSTEM_PROMPT = [
  'You write a handoff note for an engineer (or an agent) who will pick up this Operator Console thread tomorrow.',
  'Write at most three short sections, each a few bullet points:',
  '"Where it stopped" (what was being done and the last concrete result),',
  '"Open" (unresolved problems, pending approvals, failing checks, with VTIDs, PR numbers or file paths when the thread names them),',
  '"Next" (the next concrete step).',
  'Use only what is in the thread. Never invent VTIDs, PRs, files or results.',
  'If the thread holds no work worth handing over (greetings, a single factual question), reply with exactly: NONE',
].join(' ');

export interface HandoffThread {
  id: string;
  user_id: string | null;
  title: string | null;
  summary: string | null;
  last_message_at: string | null;
}

export interface HandoffMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_name?: string | null;
  created_at?: string;
}

export function threadTag(threadId: string): string {
  return `thread:${threadId}`;
}

/** The model input: title, rolling summary, then the newest messages, capped from the front. */
export function buildHandoffInput(thread: HandoffThread, messages: HandoffMessage[]): string {
  const head = [
    `Thread: ${thread.title || '(untitled)'}`,
    thread.summary ? `Summary so far:\n${thread.summary}` : '',
  ].filter(Boolean).join('\n\n');
  const lines = messages.map((m) => {
    const who = m.role === 'tool' ? `tool${m.tool_name ? ` ${m.tool_name}` : ''}` : m.role;
    return `[${who}] ${(m.content || '').replace(/\s+/g, ' ').trim()}`;
  });
  let body = lines.join('\n');
  const budget = HANDOFF_MAX_INPUT_CHARS - head.length;
  if (body.length > budget) body = body.slice(body.length - Math.max(budget, 0));
  return `${head}\n\nRecent messages (oldest first):\n${body}`;
}

export function cleanHandoff(text: string | null | undefined): string | null {
  const t = (text || '').trim();
  if (!t || /^none\.?$/i.test(t)) return null;
  return t.length > HANDOFF_MAX_CHARS ? `${t.slice(0, HANDOFF_MAX_CHARS - 1).trimEnd()}…` : t;
}

export type HandoffWriter = (prompt: string) => Promise<{ ok: boolean; text?: string | null; error?: string }>;

const routerWriter: HandoffWriter = async (prompt) => {
  const r = await callViaRouter('memory', prompt, {
    service: 'dev-memory-handoff',
    systemPrompt: HANDOFF_SYSTEM_PROMPT,
    maxTokens: 500,
  });
  return { ok: r.ok, text: r.text ?? null, error: r.error };
};

export type HandoffOutcome =
  | { status: 'written'; id: string }
  | { status: 'no_owner' | 'already_current' | 'no_messages' | 'nothing_to_hand_over' | 'unavailable' }
  | { status: 'llm_failed' | 'write_failed'; error: string };

async function latestHandoff(threadId: string): Promise<{ id: string; created_at: string } | null> {
  const s = getSupabase();
  if (!s) return null;
  const tag = encodeURIComponent(`{"${threadTag(threadId)}"}`);
  const r = await supa<Array<{ id: string; created_at: string }>>(s,
    `/rest/v1/dev_agent_memory?category=eq.handoff&tags=cs.${tag}&superseded_by=is.null&select=id,created_at&order=created_at.desc&limit=1`);
  return r.ok && r.data && r.data[0] ? r.data[0] : null;
}

/** Write (or refresh) one thread's handoff. Never throws. */
export async function writeThreadHandoff(
  thread: HandoffThread,
  opts: { writer?: HandoffWriter } = {},
): Promise<HandoffOutcome> {
  try {
    if (!thread.user_id) return { status: 'no_owner' };
    const s = getSupabase();
    if (!s) return { status: 'unavailable' };
    const prior = await latestHandoff(thread.id);
    if (prior && thread.last_message_at && Date.parse(prior.created_at) >= Date.parse(thread.last_message_at)) {
      return { status: 'already_current' };
    }
    const m = await supa<HandoffMessage[]>(s,
      `/rest/v1/operator_messages?thread_id=eq.${encodeURIComponent(thread.id)}&select=role,content,tool_name,created_at&order=created_at.desc&limit=${HANDOFF_MESSAGE_WINDOW}`);
    const messages = (m.ok && m.data ? m.data : []).slice().reverse();
    if (messages.length === 0) return { status: 'no_messages' };

    const r = await (opts.writer || routerWriter)(buildHandoffInput(thread, messages));
    if (!r.ok) return { status: 'llm_failed', error: r.error || 'router_failed' };
    const text = cleanHandoff(r.text);
    if (!text) return { status: 'nothing_to_hand_over' };

    const vtids = Array.from(new Set((`${thread.summary || ''}\n${text}`).match(/VTID-\d{4,5}/g) || []));
    const w = await writeDevMemory({
      repo: 'vitana-platform',
      category: 'handoff',
      title: `Handoff: ${thread.title || 'Operator thread'}`.slice(0, 120),
      content: text,
      vtid: vtids[0],
      importance: 60,
      source: 'session',
      tags: [threadTag(thread.id), 'handoff', ...vtids.slice(0, 5)],
      supersedes: prior?.id,
      authorUserId: thread.user_id,
      stage: 'operator',
    });
    if (!w.ok) return { status: 'write_failed', error: w.error };
    return { status: 'written', id: w.id };
  } catch (err) {
    return { status: 'write_failed', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Threads that went quiet: owned, active in the last HANDOFF_LOOKBACK_HOURS,
 * silent for at least `idleMinutes`. An hourly sweep over these covers both
 * "end of thread" and "end of day" without a client signal.
 */
export async function findIdleThreads(
  now: Date,
  opts: { idleMinutes?: number; limit?: number } = {},
): Promise<HandoffThread[]> {
  const s = getSupabase();
  if (!s) return [];
  const since = new Date(now.getTime() - HANDOFF_LOOKBACK_HOURS * 3600_000).toISOString();
  const until = new Date(now.getTime() - (opts.idleMinutes ?? HANDOFF_IDLE_MINUTES) * 60_000).toISOString();
  const limit = Math.max(1, Math.min(opts.limit ?? HANDOFF_SWEEP_LIMIT, 100));
  const r = await supa<HandoffThread[]>(s,
    `/rest/v1/operator_threads?user_id=not.is.null&last_message_at=gte.${encodeURIComponent(since)}&last_message_at=lte.${encodeURIComponent(until)}&select=id,user_id,title,summary,last_message_at&order=last_message_at.desc&limit=${limit}`);
  return r.ok && r.data ? r.data : [];
}

export interface HandoffSweepResult {
  candidates: number;
  outcomes: Record<string, number>;
  written: number;
}

export async function runHandoffSweep(
  opts: { now?: Date; writer?: HandoffWriter; idleMinutes?: number; limit?: number; budgetMs?: number } = {},
): Promise<HandoffSweepResult> {
  const now = opts.now || new Date();
  const started = Date.now();
  const budget = opts.budgetMs ?? 4 * 60_000;
  const threads = await findIdleThreads(now, opts);
  const outcomes: Record<string, number> = {};
  let written = 0;
  for (const t of threads) {
    if (Date.now() - started > budget) { outcomes.budget_exhausted = (outcomes.budget_exhausted ?? 0) + 1; break; }
    const o = await writeThreadHandoff(t, { writer: opts.writer });
    outcomes[o.status] = (outcomes[o.status] ?? 0) + 1;
    if (o.status === 'written') written++;
    else if (o.status === 'llm_failed' || o.status === 'write_failed') {
      console.warn(`[dev-memory-handoff] thread ${t.id.slice(0, 8)} ${o.status}: ${o.error}`);
    }
  }
  return { candidates: threads.length, outcomes, written };
}
