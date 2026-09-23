/**
 * VTID-04391: one `daily_learning` episode per active user per local day.
 *
 * The next morning Vitana should be able to say "yesterday you slept six
 * hours and skipped the walk — want a lighter plan?" without re-reading every
 * turn. Once a day, in the user's own evening, the day's diary entries,
 * session summaries and newly learned facts are condensed by the `memory`
 * routing stage into one short note, stored as a `memory_items` episode
 * (`category_key 'daily_learning'`, `content_json.date` = the user's local
 * date). Recall and the Daily summary screen both read it.
 *
 * At most one per (user, date): the partial unique index
 * uq_memory_items_daily_learning makes a second insert fail with 23505,
 * which is treated as already written. Importance stays at 50 so
 * trg_notify_memory_garden does not notify.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { callViaRouter } from '../llm-router';
import { buildLocalizedSystemPrompt } from '../../i18n/llm-locale';
import type { GatewayLocale } from '../../i18n/catalog';

export const DAILY_LEARNING_LOCAL_HOUR = 22;
export const MAX_DAY_INPUT_CHARS = 10_000;
export const MAX_LEARNING_CHARS = 700;

export const DAILY_LEARNING_SYSTEM_PROMPT = [
  'You write a short end-of-day memory note for Vitana, a health and longevity assistant, about one user.',
  'The input lists what happened today: diary entries, summaries of conversations, and facts learned.',
  'Write 2 to 4 sentences in the third person ("The user ..."): what the day was like, anything about sleep, movement, food, mood or stress, what the user decided or planned, and one thing worth following up tomorrow.',
  'Use only what is in the input. Never invent anything.',
  'If nothing is worth remembering, reply with exactly: NONE',
].join(' ');

/** The user's local calendar date (YYYY-MM-DD) for an instant. */
export function localDate(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export interface DayItem {
  kind: 'diary' | 'session_summary' | 'fact';
  text: string;
  at: string;
}

/** Plain-text input for the model, oldest first, capped. */
export function renderDay(items: DayItem[]): string {
  const label: Record<DayItem['kind'], string> = { diary: 'Diary', session_summary: 'Conversation', fact: 'Learned' };
  const lines = [...items]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((i) => `${label[i.kind]}: ${i.text.replace(/\s+/g, ' ').trim()}`);
  let out = lines.join('\n');
  if (out.length > MAX_DAY_INPUT_CHARS) out = out.slice(out.length - MAX_DAY_INPUT_CHARS);
  return out;
}

export function cleanLearning(text: string | null | undefined): string | null {
  const t = (text || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
  if (!t || /^none\.?$/i.test(t)) return null;
  return t.length > MAX_LEARNING_CHARS ? `${t.slice(0, MAX_LEARNING_CHARS - 1).trimEnd()}…` : t;
}

/** Users in the tenant with a diary entry or a session summary in the last 26 hours. */
export async function findActiveUsers(sb: SupabaseClient, tenantId: string, now: Date, limit = 500): Promise<string[]> {
  const since = new Date(now.getTime() - 26 * 3600 * 1000).toISOString();
  const { data, error } = await sb
    .from('memory_items')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .in('category_key', ['session_summary'])
    .gte('occurred_at', since)
    .limit(5000);
  const { data: diary, error: dErr } = await sb
    .from('memory_items')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('source', 'diary')
    .gte('occurred_at', since)
    .limit(5000);
  if (error && dErr) throw new Error(error.message);
  const ids = new Set<string>();
  for (const r of [...((data as any[]) || []), ...((diary as any[]) || [])]) if (r?.user_id) ids.add(r.user_id);
  return [...ids].slice(0, limit);
}

/** Today's (local date) diary entries, session summaries and new facts for one user. */
export async function gatherDay(
  sb: SupabaseClient,
  identity: { tenant_id: string; user_id: string },
  date: string,
  tz: string,
  now: Date,
): Promise<DayItem[]> {
  const since = new Date(now.getTime() - 30 * 3600 * 1000).toISOString();
  const [itemsRes, factsRes] = await Promise.all([
    sb
      .from('memory_items')
      .select('content, category_key, source, occurred_at')
      .eq('tenant_id', identity.tenant_id)
      .eq('user_id', identity.user_id)
      .gte('occurred_at', since)
      .or('category_key.eq.session_summary,source.eq.diary')
      .order('occurred_at', { ascending: true })
      .limit(60),
    sb
      .from('memory_facts')
      .select('fact_key, fact_value, extracted_at')
      .eq('tenant_id', identity.tenant_id)
      .eq('user_id', identity.user_id)
      .is('superseded_at', null)
      .gte('extracted_at', since)
      .neq('fact_key', 'preferred_language')
      .limit(30),
  ]);
  const out: DayItem[] = [];
  for (const r of ((itemsRes.data as any[]) || [])) {
    if (localDate(new Date(r.occurred_at), tz) !== date) continue;
    out.push({ kind: r.category_key === 'session_summary' ? 'session_summary' : 'diary', text: r.content, at: r.occurred_at });
  }
  for (const f of ((factsRes.data as any[]) || [])) {
    if (localDate(new Date(f.extracted_at), tz) !== date) continue;
    out.push({ kind: 'fact', text: `${String(f.fact_key).replace(/_/g, ' ')}: ${f.fact_value}`, at: f.extracted_at });
  }
  return out;
}

export async function hasDailyLearning(sb: SupabaseClient, userId: string, date: string): Promise<boolean> {
  const { data } = await sb
    .from('memory_items')
    .select('id')
    .eq('user_id', userId)
    .eq('category_key', 'daily_learning')
    .eq('content_json->>date', date)
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

export type DailyLearningOutcome =
  | { status: 'written'; id: string | null; chars: number }
  | { status: 'nothing_to_learn' | 'already_written' | 'shadow' | 'llm_failed' | 'write_failed'; error?: string };

/** Build and store one user's daily learning. Never throws. */
export async function writeDailyLearning(
  sb: SupabaseClient,
  identity: { tenant_id: string; user_id: string },
  date: string,
  items: DayItem[],
  opts: { locale?: GatewayLocale | null; shadow?: boolean } = {},
): Promise<DailyLearningOutcome> {
  if (items.length === 0) return { status: 'nothing_to_learn' };
  if (await hasDailyLearning(sb, identity.user_id, date)) return { status: 'already_written' };
  const input = renderDay(items);
  const r = await callViaRouter('memory', input, {
    service: 'daily-learning',
    systemPrompt: buildLocalizedSystemPrompt(DAILY_LEARNING_SYSTEM_PROMPT, opts.locale ?? null),
    maxTokens: 300,
  });
  if (!r.ok) return { status: 'llm_failed', error: r.error };
  const text = cleanLearning(r.text);
  if (!text) return { status: 'nothing_to_learn' };
  if (opts.shadow) return { status: 'shadow' };
  const { data, error } = await sb
    .from('memory_items')
    .insert({
      tenant_id: identity.tenant_id,
      user_id: identity.user_id,
      category_key: 'daily_learning',
      source: 'system',
      content: text,
      content_json: {
        kind: 'daily_learning',
        date,
        inputs: { diary: items.filter((i) => i.kind === 'diary').length, sessions: items.filter((i) => i.kind === 'session_summary').length, facts: items.filter((i) => i.kind === 'fact').length },
        provider: r.provider ?? null,
      },
      importance: 50,
      occurred_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) {
    if (/duplicate key|23505/i.test(error.message)) return { status: 'already_written' };
    return { status: 'write_failed', error: error.message };
  }
  void embedLater((data as any)?.id, text);
  return { status: 'written', id: (data as any)?.id ?? null, chars: text.length };
}

async function embedLater(id: string | undefined, text: string): Promise<void> {
  if (!id) return;
  try {
    const { embedMemoryText, toPgVector } = await import('../memory-embedding');
    const emb = await embedMemoryText(text);
    if (!emb.ok || !emb.embedding) return;
    const { getSupabase } = await import('../../lib/supabase');
    const sb = getSupabase();
    if (!sb) return;
    await sb.from('memory_items').update({ embedding: toPgVector(emb.embedding), embedding_model: emb.model, embedding_updated_at: new Date().toISOString() }).eq('id', id);
  } catch {
    /* AP-0910 backfills NULL embeddings */
  }
}

/** The user's daily learnings, newest first (for the Daily summary screen). */
export async function listDailyLearnings(
  sb: SupabaseClient,
  identity: { tenant_id: string; user_id: string },
  limit = 14,
): Promise<Array<{ id: string; date: string; content: string; created_at: string }>> {
  const { data, error } = await sb
    .from('memory_items')
    .select('id, content, content_json, occurred_at')
    .eq('tenant_id', identity.tenant_id)
    .eq('user_id', identity.user_id)
    .eq('category_key', 'daily_learning')
    .order('occurred_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 60));
  if (error) throw new Error(error.message);
  return ((data as any[]) || []).map((r) => ({ id: r.id, date: r.content_json?.date ?? String(r.occurred_at).slice(0, 10), content: r.content, created_at: r.occurred_at }));
}
