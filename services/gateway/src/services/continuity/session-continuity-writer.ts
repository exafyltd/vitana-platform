/**
 * VTID-04353 (WS-0.4) — write the continuity a finished session leaves behind.
 *
 * `user_open_threads` and `assistant_promises` (VTID-02932) are read on every
 * session start by the continuity compiler, but nothing ever wrote them: both
 * tables stayed empty and the "unfinished topic" / "promise I owe you" rungs
 * could never fire. This module is the writer, called once per finalized
 * session:
 *
 *  - one `memory`-stage call (llm_routing_policy decides the provider — never
 *    named here) that returns JSON: at most 3 open threads and 3 promises;
 *  - an open thread whose topic matches one the user already has open is
 *    touched (session_id_last, last_mentioned_at, summary) instead of
 *    duplicated;
 *  - every promise is inserted as `owed`.
 *
 * Best-effort by construction: any failure returns counts of 0 with a reason
 * and never throws, because session teardown must not depend on it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../lib/supabase';
import { callViaRouter } from '../llm-router';

const LOG_PREFIX = '[VTID-04353:continuity-writer]';

export const MAX_THREADS = 3;
export const MAX_PROMISES = 3;
const MAX_TOPIC_CHARS = 120;
const MAX_SUMMARY_CHARS = 400;
const MAX_PROMISE_CHARS = 300;
const MAX_TRANSCRIPT_TURN_CHARS = 400;

const CONTINUITY_SYSTEM_PROMPT = `You read a finished conversation between a User and an AI assistant named Vitana and list what is still open for next time.

Return ONLY a JSON object, no prose, no markdown fences:
{"open_threads":[{"topic":"...","summary":"..."}],"promises":[{"text":"...","due_hint":"..."}]}

open_threads — topics the user raised that were NOT finished: a plan they are still deciding, a problem not yet solved, something they said they would come back to. At most ${MAX_THREADS}. "topic" is a short noun phrase (max 8 words); "summary" is one sentence on where it was left.
promises — things Vitana said IT would do or follow up on later ("I will remind you", "next time I'll show you"). At most ${MAX_PROMISES}. "text" states the promise from Vitana's side in one sentence; "due_hint" is a time the conversation named ("tomorrow morning", "next week") or "" when none was named.

Rules:
- Only what is in the transcript. Never invent.
- Skip greetings, small talk, and anything already completed in the conversation.
- Refer to the user as "the user".
- When nothing is open, return {"open_threads":[],"promises":[]}.`;

export interface ExtractedThread {
  topic: string;
  summary: string;
}

export interface ExtractedPromise {
  text: string;
  due_hint: string;
}

export interface ExtractedContinuity {
  open_threads: ExtractedThread[];
  promises: ExtractedPromise[];
}

export interface RecordSessionContinuityInput {
  tenant_id: string;
  user_id: string;
  session_id: string;
  transcript_turns: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export interface RecordSessionContinuityResult {
  ok: boolean;
  threads_written: number;
  threads_touched: number;
  promises_written: number;
  reason?: string;
}

function clip(s: unknown, max: number): string {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Normalize a topic for the "same open thread" comparison. */
export function normalizeTopic(topic: string): string {
  return topic
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Tolerant parse of the model's reply. Accepts a fenced block or prose around
 * the object; drops malformed entries; clamps counts and lengths; dedupes
 * threads by normalized topic. Never throws.
 */
export function parseContinuityReply(raw: string | null | undefined): ExtractedContinuity {
  const empty: ExtractedContinuity = { open_threads: [], promises: [] };
  if (!raw) return empty;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return empty;
  let obj: any;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return empty;
  }
  if (!obj || typeof obj !== 'object') return empty;

  const seen = new Set<string>();
  const open_threads: ExtractedThread[] = [];
  for (const t of Array.isArray(obj.open_threads) ? obj.open_threads : []) {
    const topic = clip(t?.topic, MAX_TOPIC_CHARS);
    if (!topic) continue;
    const key = normalizeTopic(topic);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    open_threads.push({ topic, summary: clip(t?.summary, MAX_SUMMARY_CHARS) });
    if (open_threads.length >= MAX_THREADS) break;
  }

  const promises: ExtractedPromise[] = [];
  for (const p of Array.isArray(obj.promises) ? obj.promises : []) {
    const text = clip(p?.text, MAX_PROMISE_CHARS);
    if (!text) continue;
    promises.push({ text, due_hint: clip(p?.due_hint, 60) });
    if (promises.length >= MAX_PROMISES) break;
  }

  return { open_threads, promises };
}

export function isSessionContinuityWriteEnabled(
  raw: string | undefined = process.env.ORB_SESSION_CONTINUITY_WRITE_ENABLED,
): boolean {
  return raw !== 'false';
}

async function extractContinuity(
  turns: RecordSessionContinuityInput['transcript_turns'],
  sessionId: string,
): Promise<ExtractedContinuity | null> {
  const transcript = turns
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${clip(t.text, MAX_TRANSCRIPT_TURN_CHARS)}`)
    .join('\n');
  const r = await callViaRouter('memory', transcript, {
    service: 'session-continuity-writer',
    systemPrompt: CONTINUITY_SYSTEM_PROMPT,
    maxTokens: 500,
  });
  if (!r.ok || !r.text) {
    console.warn(`${LOG_PREFIX} extraction failed for ${sessionId} via ${r.provider ?? 'router'}: ${r.error ?? 'empty response'}`);
    return null;
  }
  return parseContinuityReply(r.text);
}

export async function writeExtractedContinuity(
  supabase: SupabaseClient,
  input: Omit<RecordSessionContinuityInput, 'transcript_turns'>,
  extracted: ExtractedContinuity,
  nowIso: string = new Date().toISOString(),
): Promise<Omit<RecordSessionContinuityResult, 'ok' | 'reason'>> {
  let threads_written = 0;
  let threads_touched = 0;
  let promises_written = 0;

  if (extracted.open_threads.length > 0) {
    const { data: existing, error } = await supabase
      .from('user_open_threads')
      .select('thread_id, topic')
      .eq('tenant_id', input.tenant_id)
      .eq('user_id', input.user_id)
      .eq('status', 'open')
      .limit(50);
    if (error) throw new Error(`open threads read failed: ${error.message}`);
    const byTopic = new Map<string, string>();
    for (const row of (existing ?? []) as Array<{ thread_id: string; topic: string }>) {
      byTopic.set(normalizeTopic(row.topic || ''), row.thread_id);
    }

    for (const t of extracted.open_threads) {
      const match = byTopic.get(normalizeTopic(t.topic));
      if (match) {
        const { error: upErr } = await supabase
          .from('user_open_threads')
          .update({
            summary: t.summary || null,
            session_id_last: input.session_id,
            last_mentioned_at: nowIso,
          })
          .eq('thread_id', match);
        if (upErr) throw new Error(`open thread update failed: ${upErr.message}`);
        threads_touched += 1;
      } else {
        const { error: insErr } = await supabase.from('user_open_threads').insert({
          tenant_id: input.tenant_id,
          user_id: input.user_id,
          topic: t.topic,
          summary: t.summary || null,
          session_id_first: input.session_id,
          session_id_last: input.session_id,
          last_mentioned_at: nowIso,
        });
        if (insErr) throw new Error(`open thread insert failed: ${insErr.message}`);
        threads_written += 1;
      }
    }
  }

  if (extracted.promises.length > 0) {
    const rows = extracted.promises.map((p) => ({
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      session_id: input.session_id,
      // due_hint is free text from the conversation; it is kept in the
      // promise text rather than guessed into a timestamp.
      promise_text: p.due_hint ? `${p.text} (${p.due_hint})` : p.text,
    }));
    const { error: pErr } = await supabase.from('assistant_promises').insert(rows);
    if (pErr) throw new Error(`promise insert failed: ${pErr.message}`);
    promises_written = rows.length;
  }

  return { threads_written, threads_touched, promises_written };
}

export async function recordSessionContinuity(
  input: RecordSessionContinuityInput,
  deps: {
    supabase?: SupabaseClient | null;
    extract?: typeof extractContinuity;
  } = {},
): Promise<RecordSessionContinuityResult> {
  const zero = { threads_written: 0, threads_touched: 0, promises_written: 0 };
  try {
    if (!input.tenant_id || !input.user_id) return { ok: false, ...zero, reason: 'missing_identity' };
    if (!input.transcript_turns.some((t) => t.role === 'user' && t.text.trim())) {
      return { ok: false, ...zero, reason: 'no_user_turn' };
    }
    const supabase = deps.supabase === undefined ? getSupabase() : deps.supabase;
    if (!supabase) return { ok: false, ...zero, reason: 'storage_unavailable' };

    const extracted = await (deps.extract ?? extractContinuity)(input.transcript_turns, input.session_id);
    if (!extracted) return { ok: false, ...zero, reason: 'extraction_failed' };
    if (extracted.open_threads.length === 0 && extracted.promises.length === 0) {
      return { ok: true, ...zero };
    }
    const counts = await writeExtractedContinuity(supabase, input, extracted);
    return { ok: true, ...counts };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG_PREFIX} write failed for ${input.session_id}: ${reason}`);
    return { ok: false, ...zero, reason };
  }
}
