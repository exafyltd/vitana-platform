/**
 * VTID-04438 (Plan v1 WS-4.1) — the structured nightly profile.
 *
 * The nightly synthesis (user-model-synthesis.ts, AP-0911) used to write one
 * prose narrative from memory facts, routines, the Life Compass goal and the
 * Vitana Index. It now also reads recent conversation summaries, diary entries
 * and suggestion outcomes, and writes a structured profile:
 *
 *   summary          4-6 sentences of connected prose (stored as `narrative`
 *                    too, so every existing reader keeps working)
 *   preferences      what the user likes, dislikes, how they want to be spoken to
 *   routines         recurring patterns
 *   open_threads     things in progress the user may want to pick back up
 *   what_works       what helps this person, from their own history
 *   suggestion_fit   computed here, not by the model: which kinds of
 *                    suggestion this user takes up or turns down
 *
 * This module is pure: parsing, bounding and rendering. The rendered block is
 * data, not instructions (no imperative wording, no quoted lines), so it is
 * safe inside any voice instruction (Nova's filter reacts to imperative piles,
 * VTID-04124).
 */

export const PROFILE_SCHEMA_VERSION = 2;
export const PROFILE_LIST_MAX = 6;
export const PROFILE_ITEM_MAX_CHARS = 160;
export const PROFILE_SUMMARY_MAX_CHARS = 900;
/** Hard bound on the rendered block. */
export const PROFILE_BLOCK_MAX_CHARS = 2_400;
export const PROFILE_BLOCK_HEADER = '=== USER PROFILE (nightly synthesis)';

export type ProfileListKey = 'preferences' | 'routines' | 'open_threads' | 'what_works';
export const PROFILE_LIST_KEYS: readonly ProfileListKey[] = ['preferences', 'routines', 'open_threads', 'what_works'];

export interface SuggestionFit {
  provider: string;
  label: string;
  accepted: number;
  settled: number;
  /** 'takes_up' or 'turns_down' */
  fit: 'takes_up' | 'turns_down';
}

export interface StructuredProfile {
  summary: string;
  preferences: string[];
  routines: string[];
  open_threads: string[];
  what_works: string[];
  suggestion_fit: SuggestionFit[];
}

const clean = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const c = clean(x, PROFILE_ITEM_MAX_CHARS);
    if (c && !out.some((y) => y.toLowerCase() === c.toLowerCase())) out.push(c);
    if (out.length >= PROFILE_LIST_MAX) break;
  }
  return out;
}

/**
 * Parse the model's answer. JSON with a summary gives a structured profile;
 * anything else is treated as prose (the pre-VTID-04438 shape), so a model
 * that ignores the JSON request still yields a usable narrative.
 */
export function parseProfileOutput(raw: string | null | undefined): Omit<StructuredProfile, 'suggestion_fit'> | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as Record<string, unknown>;
      const summary = typeof o.summary === 'string' ? clean(o.summary, PROFILE_SUMMARY_MAX_CHARS) : '';
      if (summary.length >= 40) {
        return {
          summary,
          preferences: cleanList(o.preferences),
          routines: cleanList(o.routines),
          open_threads: cleanList(o.open_threads),
          what_works: cleanList(o.what_works),
        };
      }
    } catch {
      /* fall through to prose */
    }
  }
  if (text.startsWith('{')) return null; // broken JSON is not prose
  const summary = clean(text, PROFILE_SUMMARY_MAX_CHARS);
  if (summary.length < 40) return null;
  return { summary, preferences: [], routines: [], open_threads: [], what_works: [] };
}

/** Plain-English names for the continuation providers, for the profile only. */
const PROVIDER_LABELS: Record<string, string> = {
  journey_guide: 'next steps on their journey',
  login_briefing: 'a daily briefing',
  unread_messages_announce: 'mentions of unread messages',
  goal_completion_inquiry: 'check-ins on their goals',
  new_day_return: 'a new-day overview',
  feature_discovery_teacher: 'tips about app features',
  contextual_next_action: 'next-step suggestions for the screen they are on',
  real_life_invite: 'real-life meetup invitations',
  partner_health_result_ready: 'news about health results',
  reminder_due: 'reminders',
  guided_topic_narration: 'guided lessons',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.replace(/_/g, ' ');
}

/**
 * Which kinds of suggestion this user takes up or turns down — computed from
 * counts, never inferred by the model. Needs 3 settled offers per provider;
 * ≥ 60 % accepted is "takes up", ≤ 20 % is "turns down".
 */
export function computeSuggestionFit(
  outcomes: Array<{ provider: string; accepted: number; declined: number; ignored: number }>,
): SuggestionFit[] {
  const out: SuggestionFit[] = [];
  for (const o of outcomes) {
    const settled = o.accepted + o.declined + o.ignored;
    if (settled < 3) continue;
    const rate = o.accepted / settled;
    if (rate >= 0.6) out.push({ provider: o.provider, label: providerLabel(o.provider), accepted: o.accepted, settled, fit: 'takes_up' });
    else if (rate <= 0.2) out.push({ provider: o.provider, label: providerLabel(o.provider), accepted: o.accepted, settled, fit: 'turns_down' });
  }
  return out.sort((a, b) => b.settled - a.settled).slice(0, PROFILE_LIST_MAX);
}

/** How many of the profile's parts are filled (summary + 4 lists + fit), 0..6. */
export function profileSectionsFilled(p: Partial<StructuredProfile> | null | undefined): number {
  if (!p) return 0;
  let n = p.summary ? 1 : 0;
  for (const k of PROFILE_LIST_KEYS) if (Array.isArray(p[k]) && (p[k] as string[]).length) n += 1;
  if (Array.isArray(p.suggestion_fit) && p.suggestion_fit.length) n += 1;
  return n;
}

/** Read a stored `user_profile_narrative_v1` value into a profile (v1 prose or v2). */
export function profileFromStoredValue(value: unknown): StructuredProfile | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const s = (v.structured && typeof v.structured === 'object' ? v.structured : {}) as Record<string, unknown>;
  const summary = typeof s.summary === 'string' ? s.summary : typeof v.narrative === 'string' ? v.narrative : '';
  if (!summary.trim()) return null;
  const fit = Array.isArray(s.suggestion_fit) ? (s.suggestion_fit as unknown[]) : [];
  return {
    summary: clean(summary, PROFILE_SUMMARY_MAX_CHARS),
    preferences: cleanList(s.preferences),
    routines: cleanList(s.routines),
    open_threads: cleanList(s.open_threads),
    what_works: cleanList(s.what_works),
    suggestion_fit: fit
      .filter((f): f is SuggestionFit => !!f && typeof f === 'object' && typeof (f as SuggestionFit).label === 'string'
        && ((f as SuggestionFit).fit === 'takes_up' || (f as SuggestionFit).fit === 'turns_down'))
      .slice(0, PROFILE_LIST_MAX),
  };
}

/**
 * The block injected into the voice instruction. Data only: a header, the
 * summary and labelled lists. Bounded to PROFILE_BLOCK_MAX_CHARS, dropping
 * list items from the end first.
 */
export function renderProfileBlock(p: StructuredProfile, ageLabel: string): string {
  const lines: string[] = [`${PROFILE_BLOCK_HEADER} — generated ${ageLabel} ago; background about the user, not a script ===`, p.summary];
  const section = (title: string, items: string[]) => {
    if (items.length) lines.push(`${title}:`, ...items.map((i) => `- ${i}`));
  };
  section('Preferences', p.preferences);
  section('Routines', p.routines);
  section('Open threads', p.open_threads);
  section('What works for them', p.what_works);
  const takes = p.suggestion_fit.filter((f) => f.fit === 'takes_up').map((f) => `${f.label} (${f.accepted} of ${f.settled} taken up)`);
  const turns = p.suggestion_fit.filter((f) => f.fit === 'turns_down').map((f) => `${f.label} (${f.accepted} of ${f.settled} taken up)`);
  section('Suggestions they usually take up', takes);
  section('Suggestions they usually turn down', turns);
  lines.push('=== END USER PROFILE ===');
  let text = lines.join('\n');
  while (text.length > PROFILE_BLOCK_MAX_CHARS) {
    let i = -1;
    for (let k = lines.length - 2; k >= 0; k--) if (lines[k].startsWith('- ')) { i = k; break; }
    if (i < 0) break;
    lines.splice(i, 1);
    text = lines.join('\n');
  }
  if (text.length > PROFILE_BLOCK_MAX_CHARS) text = `${text.slice(0, PROFILE_BLOCK_MAX_CHARS - 30)}\n=== END USER PROFILE ===`;
  return text;
}

/** Whether the brain instruction carries the profile block (kill switch). */
export function isProfileBlockEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BRAIN_PROFILE_BLOCK !== 'false';
}
