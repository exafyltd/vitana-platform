/**
 * VTID-04444 (Conversation rebuild WS-4.2) — nightly diary theme rollup.
 *
 * Loop 10 of the nightly consolidator (VTID-02632) was a stub: it counted
 * yesterday's rows and said the LLM rollup was "deferred to brain
 * unification". This is that rollup.
 *
 * For each user with enough recent diary entries it asks the `memory` routing
 * stage (Bedrock under the standing policy — never named here) which themes
 * run through the last 30 days of entries, and stores the answer in
 * user_assistant_state under `diary_themes_v1`. The nightly profile synthesis
 * (VTID-04438, WS-4.1) reads it as one more input, so the profile sees a
 * month of the diary instead of the last eight entries.
 *
 * What the model decides and what it does not:
 *   - The model names the themes and says WHICH numbered entries carry each
 *     one. Counts, last-seen dates and the trend (rising / steady / fading)
 *     are computed here from those entry numbers and the entries' own dates,
 *     so the model cannot invent a frequency.
 *   - People are kept only as lowercase relationship words ("partner",
 *     "a colleague"). Anything capitalised — a name — is dropped here, not
 *     left to the prompt.
 *   - Themes, the mood arc and people are English data for the model's
 *     private context. Nothing here is spoken (NEVER-rule 41).
 *
 * Off by default: CONSOLIDATOR_DIARY_ROLLUP_ENABLED must be exactly 'true'.
 * With it unset, the consolidator's loop 10 is byte-for-byte the previous
 * count-only pass and AP-0915 does nothing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { callViaRouter } from '../llm-router'; // provider from llm_routing_policy, never hardcoded
import * as repo from './diary-theme-rollup-repository';

export const SIGNAL_DIARY_THEMES = 'diary_themes_v1';
export const DIARY_THEMES_SCHEMA_VERSION = 1;

export const DIARY_ROLLUP_WINDOW_DAYS = 30;
export const DIARY_ROLLUP_MIN_ENTRIES = 3;
export const DIARY_ROLLUP_MAX_ENTRIES = 20;
export const DIARY_ROLLUP_ENTRY_CHARS = 300;
export const DIARY_ROLLUP_MAX_THEMES = 6;
export const DIARY_ROLLUP_MAX_PEOPLE = 6;
export const DIARY_THEME_LABEL_CHARS = 60;
export const DIARY_MOOD_ARC_CHARS = 160;
/** Entries newer than this count as "recent" for the trend. */
export const DIARY_TREND_RECENT_DAYS = 7;
/** Model calls per run (users whose entries did not change cost nothing). */
export const DIARY_ROLLUP_MAX_USERS_PER_RUN = 25;
export const DIARY_ROLLUP_TIME_BUDGET_MS = 4 * 60 * 1000;
/** The profile synthesis ignores a rollup older than this. */
export const DIARY_THEMES_MAX_AGE_DAYS = 14;
/** Rows scanned to find candidate authors. */
const AUTHOR_SCAN_LIMIT = 5000;

const DAY_MS = 86_400_000;

export function isDiaryRollupEnabled(raw: string | undefined = process.env.CONSOLIDATOR_DIARY_ROLLUP_ENABLED): boolean {
  return raw === 'true';
}

export interface DiaryEntryInput {
  text: string;
  created_at: string;
}

export type DiaryThemeTrend = 'rising' | 'steady' | 'fading';

export interface DiaryTheme {
  label: string;
  entries: number;
  last_seen: string;
  trend: DiaryThemeTrend;
}

export interface DiaryThemeRollup {
  themes: DiaryTheme[];
  mood_arc: string | null;
  people: string[];
}

const SYSTEM_PROMPT = `You read a wellness-community member's recent diary entries and name the themes that run through them, for their AI companion's private context. The entries are numbered.

- A theme is something the user keeps coming back to: a project, a worry, a habit, a relationship, a health focus. Name it in at most 6 neutral words.
- For each theme list the numbers of the entries that carry it. Use only numbers that appear in the input.
- STRICT GROUNDING: only name what the entries say. Invent no details, diagnoses or causes. Keep sensitive matters general ("a health worry", not the condition).
- people: the people who matter in these entries, by relationship only, in lowercase ("partner", "a colleague", "mother"). Never a name.
- mood_arc: one plain sentence on how the mood moves across the entries, or an empty string when the entries do not say.
- Write in English, about "the user" in third person.

Answer with JSON only:
{"themes": [{"label": "short theme", "entries": [1, 4]}], "mood_arc": "one sentence or empty", "people": ["relationship"]}
At most ${DIARY_ROLLUP_MAX_THEMES} themes and ${DIARY_ROLLUP_MAX_PEOPLE} people. A theme needs at least one entry.`;

const oneLine = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Numbered entries, oldest first, so entry numbers read as a timeline. */
export function buildDiaryThemePrompt(entries: DiaryEntryInput[]): string {
  const lines = ['DIARY ENTRIES (numbered, oldest first):'];
  entries.forEach((e, i) => {
    lines.push(`[${i + 1}] ${e.created_at.slice(0, 10)}: ${oneLine(e.text, DIARY_ROLLUP_ENTRY_CHARS)}`);
  });
  return lines.join('\n');
}

/** Stable change-detector: new, edited-away or aged-out entries re-run the rollup. */
export function computeDiaryInputsHash(entries: DiaryEntryInput[]): string {
  const s = JSON.stringify(entries.map((e) => `${e.created_at}|${e.text.length}`).sort());
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const t = text.replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(t.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A relationship word, not a name: all lowercase letters, spaces, hyphens, apostrophes. */
function isRelationshipWord(s: string): boolean {
  return /^[a-z][a-z' -]{1,39}$/.test(s);
}

/**
 * Validate the model's answer against the entries it was given. Entry
 * numbers outside 1..n are dropped, a theme with no valid entry is dropped,
 * duplicate labels merge, and counts / last-seen / trend are computed from
 * the entries' own dates. Null when nothing usable remains.
 */
export function parseDiaryThemeOutput(text: string, entries: DiaryEntryInput[], nowMs: number): DiaryThemeRollup | null {
  const obj = extractJsonObject(text || '');
  if (!obj) return null;
  const n = entries.length;
  const recentCutoff = nowMs - DIARY_TREND_RECENT_DAYS * DAY_MS;

  const byLabel = new Map<string, { label: string; idx: Set<number> }>();
  for (const raw of Array.isArray(obj.themes) ? obj.themes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const label = oneLine((raw as Record<string, unknown>).label, DIARY_THEME_LABEL_CHARS);
    if (!label) continue;
    const refs = Array.isArray((raw as Record<string, unknown>).entries) ? ((raw as Record<string, unknown>).entries as unknown[]) : [];
    const idx = new Set<number>();
    for (const r of refs) {
      const k = typeof r === 'number' ? r : Number(r);
      if (Number.isInteger(k) && k >= 1 && k <= n) idx.add(k - 1);
    }
    if (idx.size === 0) continue;
    const key = label.toLowerCase();
    const cur = byLabel.get(key);
    if (cur) idx.forEach((i) => cur.idx.add(i));
    else byLabel.set(key, { label, idx });
  }

  const themes: DiaryTheme[] = [...byLabel.values()].map(({ label, idx }) => {
    const times = [...idx].map((i) => Date.parse(entries[i].created_at)).filter(Number.isFinite);
    const recent = times.filter((t) => t >= recentCutoff).length;
    const older = times.length - recent;
    const trend: DiaryThemeTrend = recent === 0 ? 'fading' : recent > older ? 'rising' : 'steady';
    const last = times.length ? new Date(Math.max(...times)).toISOString().slice(0, 10) : '';
    return { label, entries: idx.size, last_seen: last, trend };
  });
  themes.sort((a, b) => b.entries - a.entries || b.last_seen.localeCompare(a.last_seen) || a.label.localeCompare(b.label));
  const kept = themes.slice(0, DIARY_ROLLUP_MAX_THEMES);
  if (kept.length === 0) return null;

  const people: string[] = [];
  for (const p of Array.isArray(obj.people) ? obj.people : []) {
    const s = oneLine(p, 40);
    if (s && isRelationshipWord(s) && !people.includes(s)) people.push(s);
    if (people.length >= DIARY_ROLLUP_MAX_PEOPLE) break;
  }
  const mood = oneLine(obj.mood_arc, DIARY_MOOD_ARC_CHARS);

  return { themes: kept, mood_arc: mood || null, people };
}

export type RollupStatus =
  | 'written'
  | 'too_few_entries'
  | 'unchanged'
  | 'model_failed'
  | 'no_themes'
  | 'read_failed'
  | 'write_failed';

export interface RollupUserResult {
  status: RollupStatus;
  entries: number;
  /** True when this user cost a model call. */
  model_called: boolean;
  error?: string;
}

export async function rollupDiaryThemesForUser(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  opts: { nowMs?: number } = {},
): Promise<RollupUserResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const since = new Date(nowMs - DIARY_ROLLUP_WINDOW_DAYS * DAY_MS).toISOString();
  const r = await repo.fetchUserDiaryEntriesSince(sb, userId, since, DIARY_ROLLUP_MAX_ENTRIES);
  if (r.error) return { status: 'read_failed', entries: 0, model_called: false, error: r.error.message };
  const entries: DiaryEntryInput[] = ((r.data || []) as Array<Record<string, unknown>>)
    .map((x) => ({ text: oneLine(x.text, DIARY_ROLLUP_ENTRY_CHARS), created_at: typeof x.created_at === 'string' ? x.created_at : '' }))
    .filter((x) => x.text.length > 0 && Number.isFinite(Date.parse(x.created_at)))
    .reverse(); // oldest first
  if (entries.length < DIARY_ROLLUP_MIN_ENTRIES) return { status: 'too_few_entries', entries: entries.length, model_called: false };

  const hash = computeDiaryInputsHash(entries);
  const existing = await repo.fetchAssistantState(sb, tenantId, userId, SIGNAL_DIARY_THEMES);
  const prior = (existing?.data as { value?: { inputs_hash?: string } } | null)?.value;
  if (prior?.inputs_hash === hash) return { status: 'unchanged', entries: entries.length, model_called: false };

  const t0 = Date.now();
  const res = await callViaRouter('memory', buildDiaryThemePrompt(entries), {
    service: 'diary-theme-rollup',
    systemPrompt: SYSTEM_PROMPT,
    maxTokens: 700,
  });
  console.log(
    `[diary-theme-rollup] user=${userId.slice(0, 8)}… entries=${entries.length} provider=${res.provider ?? 'none'} model=${res.model ?? 'none'} ok=${res.ok} latency_ms=${Date.now() - t0}`,
  );
  if (!res.ok || !res.text) {
    return { status: 'model_failed', entries: entries.length, model_called: true, error: res.error ?? 'empty response' };
  }
  const rollup = parseDiaryThemeOutput(res.text, entries, nowMs);
  if (!rollup) return { status: 'no_themes', entries: entries.length, model_called: true };

  const nowIso = new Date(nowMs).toISOString();
  const { error } = await repo.upsertAssistantState(sb, {
    tenant_id: tenantId,
    user_id: userId,
    signal_name: SIGNAL_DIARY_THEMES,
    value: {
      schema_version: DIARY_THEMES_SCHEMA_VERSION,
      generated_at: nowIso,
      inputs_hash: hash,
      window_days: DIARY_ROLLUP_WINDOW_DAYS,
      entries_considered: entries.length,
      theme_count: rollup.themes.length,
      ...rollup,
    },
    source: 'consolidator.loop_10',
    last_seen_at: nowIso,
  });
  if (error) return { status: 'write_failed', entries: entries.length, model_called: true, error: error.message };
  return { status: 'written', entries: entries.length, model_called: true };
}

export interface RollupRunResult {
  candidates: number;
  processed: number;
  written: number;
  model_calls: number;
  errors: number;
  outcomes: Partial<Record<RollupStatus, number>>;
  notes: string[];
}

/**
 * One rollup pass. `scope` pins a single user (admin smoke / self-heal);
 * otherwise candidates are users with at least DIARY_ROLLUP_MIN_ENTRIES
 * entries in the window, most active first, optionally restricted to users
 * whose primary tenant is `tenantId`. diary_entries carries no tenant, so the
 * tenant a rollup is stored under is the user's primary tenant.
 */
export async function runDiaryThemeRollup(
  sb: SupabaseClient,
  opts: {
    scope?: { tenant_id: string; user_id: string };
    tenantId?: string;
    maxModelCalls?: number;
    budgetMs?: number;
    nowMs?: number;
  } = {},
): Promise<RollupRunResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const started = Date.now();
  const maxCalls = opts.maxModelCalls ?? DIARY_ROLLUP_MAX_USERS_PER_RUN;
  const budget = opts.budgetMs ?? DIARY_ROLLUP_TIME_BUDGET_MS;
  const out: RollupRunResult = { candidates: 0, processed: 0, written: 0, model_calls: 0, errors: 0, outcomes: {}, notes: [] };

  let candidates: Array<{ tenant_id: string; user_id: string }> = [];
  if (opts.scope) {
    candidates = [opts.scope];
  } else {
    const since = new Date(nowMs - DIARY_ROLLUP_WINDOW_DAYS * DAY_MS).toISOString();
    const authors = await repo.fetchDiaryAuthorsSince(sb, since, AUTHOR_SCAN_LIMIT);
    if (authors.error) {
      out.errors += 1;
      out.notes.push(`author scan failed: ${authors.error.message}`);
      return out;
    }
    const counts = new Map<string, number>();
    for (const row of (authors.data || []) as Array<{ user_id?: string }>) {
      if (row.user_id) counts.set(row.user_id, (counts.get(row.user_id) || 0) + 1);
    }
    const userIds = [...counts.entries()]
      .filter(([, c]) => c >= DIARY_ROLLUP_MIN_ENTRIES)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id]) => id);
    if (userIds.length === 0) return out;
    const tenants = await repo.fetchPrimaryTenants(sb, userIds);
    if (tenants.error) {
      out.errors += 1;
      out.notes.push(`tenant lookup failed: ${tenants.error.message}`);
      return out;
    }
    const tenantOf = new Map<string, string>();
    for (const t of (tenants.data || []) as Array<{ user_id?: string; tenant_id?: string }>) {
      if (t.user_id && t.tenant_id) tenantOf.set(t.user_id, t.tenant_id);
    }
    const noTenant = userIds.filter((id) => !tenantOf.has(id)).length;
    if (noTenant) out.notes.push(`${noTenant} author(s) without a primary tenant skipped`);
    candidates = userIds
      .filter((id) => tenantOf.has(id) && (!opts.tenantId || tenantOf.get(id) === opts.tenantId))
      .map((id) => ({ tenant_id: tenantOf.get(id) as string, user_id: id }));
  }
  out.candidates = candidates.length;

  for (const c of candidates) {
    if (out.model_calls >= maxCalls) {
      out.notes.push(`model-call cap ${maxCalls} reached; the rest run next pass`);
      break;
    }
    if (Date.now() - started > budget) {
      out.notes.push('time budget reached; the rest run next pass');
      break;
    }
    out.processed += 1;
    try {
      const r = await rollupDiaryThemesForUser(sb, c.tenant_id, c.user_id, { nowMs });
      out.outcomes[r.status] = (out.outcomes[r.status] ?? 0) + 1;
      if (r.model_called) out.model_calls += 1;
      if (r.status === 'written') out.written += 1;
      if (r.status === 'read_failed' || r.status === 'write_failed' || r.status === 'model_failed') out.errors += 1;
    } catch (e) {
      out.errors += 1;
      out.outcomes.read_failed = (out.outcomes.read_failed ?? 0) + 1;
      out.notes.push(`user ${c.user_id.slice(0, 8)}…: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

export interface StoredDiaryThemes extends DiaryThemeRollup {
  generated_at: string;
  entries_considered: number;
}

/**
 * The stored rollup for the profile synthesis. Null when absent, older than
 * DIARY_THEMES_MAX_AGE_DAYS, unreadable or on any error — the profile is
 * built without it, as before.
 */
export async function readDiaryThemes(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  nowMs: number = Date.now(),
): Promise<StoredDiaryThemes | null> {
  try {
    const { data, error } = await repo.fetchAssistantState(sb, tenantId, userId, SIGNAL_DIARY_THEMES);
    if (error || !data) return null;
    const v = (data as { value?: Record<string, unknown> }).value;
    if (!v || typeof v.generated_at !== 'string') return null;
    const at = Date.parse(v.generated_at);
    if (!Number.isFinite(at) || nowMs - at > DIARY_THEMES_MAX_AGE_DAYS * DAY_MS) return null;
    const themes = (Array.isArray(v.themes) ? v.themes : [])
      .filter((t): t is DiaryTheme => !!t && typeof (t as DiaryTheme).label === 'string' && typeof (t as DiaryTheme).entries === 'number')
      .slice(0, DIARY_ROLLUP_MAX_THEMES);
    if (themes.length === 0) return null;
    return {
      themes,
      mood_arc: typeof v.mood_arc === 'string' && v.mood_arc ? v.mood_arc : null,
      people: (Array.isArray(v.people) ? v.people : []).filter((p): p is string => typeof p === 'string').slice(0, DIARY_ROLLUP_MAX_PEOPLE),
      generated_at: v.generated_at,
      entries_considered: typeof v.entries_considered === 'number' ? v.entries_considered : 0,
    };
  } catch {
    return null;
  }
}

/** Learning-health summary over stamps only (never the themes). */
export function summarizeDiaryThemeStamps(
  rows: Array<{ generated_at?: unknown; theme_count?: unknown; entries_considered?: unknown } | null | undefined>,
  nowMs: number,
  maxAgeDays = DIARY_THEMES_MAX_AGE_DAYS,
): { users_with_themes: number; fresh: number; avg_themes: number | null; newest_generated_at: string | null } {
  const valid = rows.filter((r): r is Record<string, unknown> => !!r && typeof r.generated_at === 'string' && Number.isFinite(Date.parse(r.generated_at as string)));
  const cutoff = nowMs - maxAgeDays * DAY_MS;
  const stamps = valid.map((r) => r.generated_at as string).sort();
  const counts = valid.map((r) => Number(r.theme_count)).filter((x) => Number.isFinite(x));
  return {
    users_with_themes: valid.length,
    fresh: stamps.filter((s) => Date.parse(s) >= cutoff).length,
    avg_themes: counts.length ? Math.round((counts.reduce((a, b) => a + b, 0) / counts.length) * 10) / 10 : null,
    newest_generated_at: stamps.length ? stamps[stamps.length - 1] : null,
  };
}
