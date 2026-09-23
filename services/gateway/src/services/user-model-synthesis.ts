/**
 * User-model synthesis — the nightly "who is this person?" narrative.
 * (BOOTSTRAP-MEMORY-DAILY-LEARNING)
 *
 * The user's picture lives in five stores (memory_facts, user_routines,
 * vitana_index_scores, life_compass, diary) that are separately queried and
 * concatenated at answer time. Nobody sounds insightful reading five lists.
 * This service has an LLM synthesize each active user into ONE compact
 * narrative profile ("Dragan, planning a September wedding to Sarah; sleep
 * is his weak pillar and dips after evening sessions; responds best to
 * concrete morning plans…") and stores it in user_assistant_state under
 * `user_profile_narrative_v1`.
 *
 * The UserContextProfiler injects the narrative into the (TTL-cached) ORB
 * bootstrap instruction, so voice sessions open with synthesized
 * understanding at zero added latency. Regenerated nightly by AP-0911 only
 * when the underlying inputs changed (inputs hash).
 *
 * Grounding contract: the prompt forbids invention — the narrative may only
 * restate and CONNECT what the inputs already say. The synthesis is written
 * in English (system-instruction language); the model answers the user in
 * their own language per the session's language directive.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { callViaRouter } from './llm-router'; // VTID-03579: provider from llm_routing_policy, never hardcoded
import * as repo from './user-model-synthesis-repository';
// VTID-04438 (WS-4.1): structured profile parsing / suggestion fit.
import {
  PROFILE_SCHEMA_VERSION,
  computeSuggestionFit,
  parseProfileOutput,
  profileFromStoredValue,
  profileSectionsFilled,
  renderProfileBlock,
  type StructuredProfile,
} from './conversation/user-profile';

export const SIGNAL_PROFILE_NARRATIVE = 'user_profile_narrative_v1';
/** Below this many live facts a narrative adds nothing — skip. */
export const MIN_FACTS_FOR_NARRATIVE = 3;
// VTID-03579: no NARRATIVE_MODEL / Vertex client here any more. Which model
// writes the narrative is a routing decision (`memory` stage), not a property
// of this module — see the cascade removal below.

// VTID-04438 (WS-4.1): the inputs now include recent conversation summaries,
// diary entries and suggestion outcomes, and the answer is structured JSON.
// A prose answer is still accepted (parseProfileOutput), so a model that
// ignores the format degrades to the previous narrative, never to nothing.
const SYNTHESIS_SYSTEM_PROMPT = `You write a compact profile of a wellness-community member for their AI companion's private context. INPUTS are records the system has stored: verified memory facts, observed routines, the active goal, the Vitana Index, summaries of recent conversations, recent diary entries and how the user responded to suggestions. Your job is to SYNTHESIZE, not to list:

- Connect related records into one picture (a goal + a routine + a weak health pillar that plausibly relate — say how).
- STRICT GROUNDING: only restate or connect what the inputs say. Invent no details, diagnoses or causes. Use hedged language ("seems to", "may be related") for connections.
- Conversation summaries and diary entries are the user's own recent words and moods: use them for open threads, preferences and what helps, and keep sensitive details general.
- Write about "the user" in third person, in English. This text is never shown to the user directly.

Answer with JSON only:
{"summary": "4 to 6 sentences of plain prose: health-relevant patterns first, then people who matter, then preferences and routines, then open threads",
 "preferences": ["short item", ...],
 "routines": ["short item", ...],
 "open_threads": ["something in progress the user may want to pick back up", ...],
 "what_works": ["what seems to help this person, from their own history", ...]}
Each list has at most 6 items of at most 20 words. Leave a list empty when the inputs say nothing about it.`;

/** VTID-04438: bounds on the broader inputs. */
export const SUMMARY_LOOKBACK_DAYS = 30;
export const DIARY_LOOKBACK_DAYS = 14;
export const MAX_SUMMARIES_IN_PROMPT = 8;
export const MAX_DIARY_IN_PROMPT = 8;
const SUMMARY_CHARS = 400;
const DIARY_CHARS = 300;

export interface SynthesisInputs {
  facts: Array<{ fact_key: string; fact_value: string; provenance_source: string }>;
  routines: Array<{ title: string; summary: string }>;
  goal: string | null;
  index: { total: number | null; weakest_pillar: string | null } | null;
  /** VTID-04438: recent conversation summaries, newest first. */
  summaries?: Array<{ summary: string; themes: string[]; ended_at: string | null }>;
  /** VTID-04438: recent diary entries, newest first. */
  diary?: Array<{ text: string; created_at: string | null }>;
  /** VTID-04438: suggestion outcomes per provider (90 days). */
  outcomes?: Array<{ provider: string; accepted: number; declined: number; ignored: number }>;
}

export interface SynthesisResult {
  ok: boolean;
  written: boolean;
  reason?: string;
}

/** Stable, cheap change-detector over the synthesis inputs. */
export function computeInputsHash(inputs: SynthesisInputs): string {
  const s = JSON.stringify([
    inputs.facts.map((f) => `${f.fact_key}=${f.fact_value}`).sort(),
    inputs.routines.map((r) => r.title).sort(),
    inputs.goal,
    inputs.index?.total ?? null,
    inputs.index?.weakest_pillar ?? null,
    // VTID-04438: new conversations, diary entries or outcomes re-synthesize.
    (inputs.summaries ?? []).map((x) => x.ended_at ?? x.summary.slice(0, 40)).sort(),
    (inputs.diary ?? []).map((x) => x.created_at ?? x.text.slice(0, 40)).sort(),
    (inputs.outcomes ?? []).map((o) => `${o.provider}:${o.accepted}/${o.declined}/${o.ignored}`).sort(),
  ]);
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

export async function gatherSynthesisInputs(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
): Promise<SynthesisInputs> {
  const [factsRes, routinesRes, goalRes, indexRes] = await Promise.all([
    repo.fetchMemoryFactsForSynthesis(supabase, tenantId, userId),
    repo.fetchUserRoutinesForSynthesis(supabase, userId),
    repo.fetchActiveLifeCompassGoal(supabase, userId),
    repo.fetchLatestVitanaIndexScore(supabase, userId),
  ]);

  let index: SynthesisInputs['index'] = null;
  const idx = (indexRes.data || [])[0] as Record<string, number> | undefined;
  if (idx && typeof idx.score_total === 'number') {
    const pillars: Array<[string, number]> = [
      ['nutrition', idx.score_nutrition],
      ['hydration', idx.score_hydration],
      ['exercise', idx.score_exercise],
      ['sleep', idx.score_sleep],
      ['mental', idx.score_mental],
    ].filter(([, v]) => typeof v === 'number') as Array<[string, number]>;
    pillars.sort((a, b) => a[1] - b[1]);
    index = { total: idx.score_total, weakest_pillar: pillars[0]?.[0] ?? null };
  }

  const [summaries, diary, outcomes] = await Promise.all([
    gatherRecentSummaries(supabase, userId),
    gatherRecentDiary(supabase, userId),
    gatherOutcomes(supabase, userId),
  ]);

  return {
    facts: (factsRes.data || []) as SynthesisInputs['facts'],
    routines: (routinesRes.data || []) as SynthesisInputs['routines'],
    goal: ((goalRes.data || [])[0] as { primary_goal?: string } | undefined)?.primary_goal ?? null,
    index,
    summaries,
    diary,
    outcomes,
  };
}

// VTID-04438: each broader input is best-effort — a failed read leaves that
// input empty and the profile is still built from the rest.
const sinceIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const oneLine = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

async function gatherRecentSummaries(supabase: SupabaseClient, userId: string): Promise<NonNullable<SynthesisInputs['summaries']>> {
  try {
    const r = await repo.fetchRecentSessionSummaries(supabase, userId, sinceIso(SUMMARY_LOOKBACK_DAYS), MAX_SUMMARIES_IN_PROMPT);
    const rows = Array.isArray(r?.data) ? (r.data as Array<Record<string, unknown>>) : [];
    return rows
      .map((x) => ({
        summary: oneLine(x.summary, SUMMARY_CHARS),
        themes: Array.isArray(x.themes) ? (x.themes as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 5) : [],
        ended_at: typeof x.ended_at === 'string' ? x.ended_at : null,
      }))
      .filter((x) => x.summary.length > 0);
  } catch {
    return [];
  }
}

async function gatherRecentDiary(supabase: SupabaseClient, userId: string): Promise<NonNullable<SynthesisInputs['diary']>> {
  try {
    const r = await repo.fetchRecentDiaryEntries(supabase, userId, sinceIso(DIARY_LOOKBACK_DAYS), MAX_DIARY_IN_PROMPT);
    const rows = Array.isArray(r?.data) ? (r.data as Array<Record<string, unknown>>) : [];
    return rows
      .map((x) => ({ text: oneLine(x.text, DIARY_CHARS), created_at: typeof x.created_at === 'string' ? x.created_at : null }))
      .filter((x) => x.text.length > 0);
  } catch {
    return [];
  }
}

async function gatherOutcomes(supabase: SupabaseClient, userId: string): Promise<NonNullable<SynthesisInputs['outcomes']>> {
  try {
    if (typeof (supabase as { rpc?: unknown }).rpc !== 'function') return [];
    const { loadUserOutcomes } = await import('./conversation/candidate-scoring');
    const rows = await loadUserOutcomes(supabase, userId);
    return Object.entries(rows).map(([provider, o]) => ({ provider, accepted: o.accepted, declined: o.declined, ignored: o.ignored }));
  } catch {
    return [];
  }
}

/** VTID-04438: enough to say something — facts, or recent conversations / diary. */
export function hasEnoughSynthesisInputs(inputs: SynthesisInputs): boolean {
  const evidence = inputs.facts.length + (inputs.summaries?.length ?? 0) + (inputs.diary?.length ?? 0);
  return inputs.facts.length >= MIN_FACTS_FOR_NARRATIVE || evidence >= MIN_FACTS_FOR_NARRATIVE + 2;
}

export function buildSynthesisPrompt(inputs: SynthesisInputs): string {
  const lines: string[] = [];
  lines.push('FACTS (verified memory records):');
  for (const f of inputs.facts) {
    lines.push(`- ${f.fact_key} = ${f.fact_value} [${f.provenance_source}]`);
  }
  if (inputs.routines.length) {
    lines.push('ROUTINES (observed behavior patterns):');
    for (const r of inputs.routines) lines.push(`- ${r.title}: ${r.summary}`);
  }
  if (inputs.goal) lines.push(`ACTIVE GOAL: ${inputs.goal}`);
  if (inputs.index) {
    lines.push(
      `VITANA INDEX: total ${inputs.index.total}${inputs.index.weakest_pillar ? `, weakest pillar: ${inputs.index.weakest_pillar}` : ''}`,
    );
  }
  if (inputs.summaries?.length) {
    lines.push('RECENT CONVERSATIONS (summaries, newest first):');
    for (const x of inputs.summaries) {
      lines.push(`- ${x.ended_at ? x.ended_at.slice(0, 10) + ': ' : ''}${x.summary}${x.themes.length ? ` [themes: ${x.themes.join(', ')}]` : ''}`);
    }
  }
  if (inputs.diary?.length) {
    lines.push('RECENT DIARY ENTRIES (the user\'s own words, newest first):');
    for (const x of inputs.diary) lines.push(`- ${x.created_at ? x.created_at.slice(0, 10) + ': ' : ''}${x.text}`);
  }
  const fit = computeSuggestionFit(inputs.outcomes ?? []);
  if (fit.length) {
    lines.push('SUGGESTION HISTORY (how the user responded to suggestions):');
    for (const f of fit) lines.push(`- ${f.fit === 'takes_up' ? 'usually takes up' : 'usually turns down'} ${f.label} (${f.accepted} of ${f.settled})`);
  }
  return lines.join('\n');
}

async function callSynthesisModel(inputs: SynthesisInputs): Promise<Omit<StructuredProfile, 'suggestion_fit'> | null> {
  const prompt = buildSynthesisPrompt(inputs);

  // VTID-03579: this used to be a hand-rolled DeepSeek -> Vertex -> Gemini-API
  // cascade. Three providers were named here, so switching the platform off
  // Google could not be done by changing routing — it needed a code change in
  // this file. The `memory` stage decides now, and its own fallback chain is
  // configured in `llm_routing_policy` rather than re-implemented per caller.
  const r = await callViaRouter('memory', prompt, {
    service: 'user-model-synthesis',
    systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
    maxTokens: 900,
  });

  if (!r.ok || !r.text) {
    console.warn(
      `[user-model-synthesis] narrative generation failed via ${r.provider ?? 'router'}: ${r.error ?? 'empty response'}`,
    );
    return null;
  }

  // A very short answer is a degenerate synthesis, not a narrative, and
  // storing it would poison the user's private context (parseProfileOutput
  // returns null below 40 characters).
  return parseProfileOutput(r.text);
}

/**
 * Synthesize + store one user's narrative. Skips (written:false) when the
 * user has too few facts or when the inputs hash is unchanged since the
 * last run — re-synthesis without new information is pure cost.
 */
export async function synthesizeUserModel(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
): Promise<SynthesisResult> {
  const inputs = await gatherSynthesisInputs(supabase, tenantId, userId);
  if (!hasEnoughSynthesisInputs(inputs)) {
    return { ok: true, written: false, reason: 'too_few_facts' };
  }
  const hash = computeInputsHash(inputs);

  const { data: existing } = await repo.fetchExistingProfileNarrativeState(
    supabase,
    tenantId,
    userId,
    SIGNAL_PROFILE_NARRATIVE,
  );
  const prior = (existing as { value?: { inputs_hash?: string } } | null)?.value;
  if (prior?.inputs_hash === hash) {
    return { ok: true, written: false, reason: 'inputs_unchanged' };
  }

  const parsed = await callSynthesisModel(inputs);
  if (!parsed) return { ok: false, written: false, reason: 'model_failed' };
  const structured: StructuredProfile = { ...parsed, suggestion_fit: computeSuggestionFit(inputs.outcomes ?? []) };

  const nowIso = new Date().toISOString();
  const { error } = await repo.upsertProfileNarrativeState(supabase, {
    tenant_id: tenantId,
    user_id: userId,
    signal_name: SIGNAL_PROFILE_NARRATIVE,
    value: {
      // `narrative` keeps every pre-VTID-04438 reader working.
      narrative: structured.summary,
      generated_at: nowIso,
      inputs_hash: hash,
      facts_count: inputs.facts.length,
      schema_version: PROFILE_SCHEMA_VERSION,
      structured,
      inputs_counts: {
        facts: inputs.facts.length,
        routines: inputs.routines.length,
        summaries: inputs.summaries?.length ?? 0,
        diary: inputs.diary?.length ?? 0,
        outcome_providers: inputs.outcomes?.length ?? 0,
      },
      sections_filled: profileSectionsFilled(structured),
    },
    last_seen_at: nowIso,
  });
  if (error) return { ok: false, written: false, reason: error.message };
  return { ok: true, written: true };
}

/**
 * VTID-04340: a narrative older than this is not injected. The profile is
 * presented to the model as current understanding of the user, so a months-old
 * one (the AP-0911 cron stopped in July) misrepresents who they are today.
 */
export const DEFAULT_NARRATIVE_MAX_AGE_DAYS = 7;

export function resolveNarrativeMaxAgeDays(
  raw: string | undefined = process.env.PROFILE_NARRATIVE_MAX_AGE_DAYS,
): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_NARRATIVE_MAX_AGE_DAYS;
}

/** Human age label for the injected section header, e.g. "5 hours", "3 days". */
export function describeNarrativeAge(ageMs: number): string {
  const hours = Math.max(0, Math.floor(ageMs / 3_600_000));
  if (hours < 1) return 'less than an hour';
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.floor(hours / 24)} days`;
}

export interface StoredProfileNarrative {
  narrative: string;
  generated_at: string;
  age_ms: number;
  /** VTID-04438: the structured profile, when the stored value carries one. */
  structured?: StructuredProfile | null;
}

/**
 * Read the stored narrative. Null when absent, stale-schema, errored, missing
 * or unparseable `generated_at`, or older than the max age (VTID-04340).
 */
export async function readUserProfileNarrative(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
  opts: { nowMs?: number; maxAgeDays?: number } = {},
): Promise<StoredProfileNarrative | null> {
  try {
    const { data, error } = await repo.fetchExistingProfileNarrativeState(
      supabase,
      tenantId,
      userId,
      SIGNAL_PROFILE_NARRATIVE,
    );
    if (error || !data) return null;
    const v = (data as { value?: { narrative?: unknown; generated_at?: unknown } }).value;
    if (!v || typeof v.narrative !== 'string' || !v.narrative.trim()) return null;
    if (typeof v.generated_at !== 'string') return null;
    const generatedMs = Date.parse(v.generated_at);
    if (!Number.isFinite(generatedMs)) return null;
    const ageMs = Math.max(0, (opts.nowMs ?? Date.now()) - generatedMs);
    const maxAgeDays = opts.maxAgeDays ?? resolveNarrativeMaxAgeDays();
    if (ageMs > maxAgeDays * 86_400_000) return null;
    const structured = (v as { structured?: unknown }).structured ? profileFromStoredValue(v) : null;
    return { narrative: v.narrative, generated_at: v.generated_at, age_ms: ageMs, ...(structured ? { structured } : {}) };
  } catch {
    return null;
  }
}

/** VTID-04438: the brain reads the profile with this bound; slower means no block. */
export const PROFILE_BLOCK_READ_TIMEOUT_MS = 800;

/**
 * VTID-04438 (WS-4.1): the profile block for the brain's core instruction —
 * and therefore for the per-user core snapshot (VTID-04399), which stores that
 * instruction. '' when disabled, absent, stale (VTID-04340 max age), slow or
 * on any error: the profile is background, never a reason to fail a build.
 */
export async function readUserProfileBlock(
  tenantId: string,
  userId: string,
  opts: { supabase?: SupabaseClient | null; nowMs?: number; timeoutMs?: number } = {},
): Promise<string> {
  try {
    const { isProfileBlockEnabled } = await import('./conversation/user-profile');
    if (!isProfileBlockEnabled() || !tenantId || !userId) return '';
    let sb = opts.supabase ?? null;
    if (!sb) {
      const { getSupabase } = await import('../lib/supabase');
      sb = getSupabase();
    }
    if (!sb) return '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stored = await Promise.race([
      readUserProfileNarrative(sb, tenantId, userId, { nowMs: opts.nowMs }),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), opts.timeoutMs ?? PROFILE_BLOCK_READ_TIMEOUT_MS); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (!stored) return '';
    const profile = stored.structured ?? profileFromStoredValue({ narrative: stored.narrative });
    return profile ? renderProfileBlock(profile, describeNarrativeAge(stored.age_ms)) : '';
  } catch {
    return '';
  }
}
