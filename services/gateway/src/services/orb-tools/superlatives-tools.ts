/**
 * Superlatives voice tools (VTID-02754).
 *
 * Community "who is...?" superlative lookups for the ORB assistant: highest
 * Vitana Index, top scorer per pillar, first/newest member, most followed,
 * plus an NL router (ask_who_is) for free-form superlative questions. All
 * handlers REUSE the VTID-02754 service layer in
 * services/voice-tools/superlatives.ts (privacy-filtered via
 * global_community_profiles.is_visible) and, for unroutable questions,
 * fall back to the same ranking pipeline the live find_community_member
 * tool uses (services/voice-tools/community-member-ranker.ts). No ranking
 * logic is re-implemented here — this module only adapts service results
 * into speakable OrbToolResult text.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import {
  getHighestVitanaIndex,
  getTopInPillar,
  getMemberByRegistration,
  getMostFollowed,
  askWhoIs,
  type Pillar,
  type SuperlativeResult,
  type SuperlativeError,
} from '../voice-tools/superlatives';
import { findCommunityMember } from '../voice-tools/community-member-ranker';
import { resolvePillarKey } from '../../lib/vitana-pillars';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

const VALID_PILLARS: readonly Pillar[] = ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'];

/**
 * Voice-friendly pillar resolution: canonical keys via resolvePillarKey,
 * plus common English/German spoken synonyms the LLM may pass through.
 */
const PILLAR_SYNONYMS: Record<string, Pillar> = {
  ernaehrung: 'nutrition',
  'ernährung': 'nutrition',
  essen: 'nutrition',
  food: 'nutrition',
  diet: 'nutrition',
  wasser: 'hydration',
  water: 'hydration',
  trinken: 'hydration',
  bewegung: 'exercise',
  sport: 'exercise',
  fitness: 'exercise',
  workout: 'exercise',
  schlaf: 'sleep',
  rest: 'sleep',
  geist: 'mental',
  mind: 'mental',
  mindfulness: 'mental',
  achtsamkeit: 'mental',
};

function resolvePillar(raw: unknown): Pillar | undefined {
  const canonical = resolvePillarKey(raw);
  if (canonical && (VALID_PILLARS as readonly string[]).includes(canonical)) {
    return canonical as Pillar;
  }
  if (typeof raw !== 'string') return undefined;
  return PILLAR_SYNONYMS[raw.trim().toLowerCase()];
}

/** ok:false when there is no authenticated user — community data is member-only. */
function authGate(tool: string, id: OrbToolIdentity, needTenant = false): OrbToolResult | null {
  if (!id.user_id || (needTenant && !id.tenant_id)) {
    return { ok: false, error: `${tool} requires an authenticated user.` };
  }
  return null;
}

/** "3 days ago" / "2 months ago" style phrase from an ISO date. */
function relativeJoinedPhrase(iso: string | null): string {
  if (!iso) return 'recently';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'recently';
  const days = (Date.now() - t) / (1000 * 60 * 60 * 24);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 7) return `${Math.round(days)} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

/** "January 2026" style phrase from an ISO date (LLM translates when speaking DE). */
function monthYearPhrase(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function displayNameOf(res: SuperlativeResult): string {
  return res.profile?.display_name || 'A community member';
}

/**
 * Empty community states ("nobody has a score yet") stay ok:true with an
 * honest spoken line — Gemini Live treats ok:false as a hard failure and
 * apologises, which is wrong for a merely-empty leaderboard.
 */
const EMPTY_ERRORS = new Set(['no_eligible_candidates', 'no_followers_data']);

function isEmptyState(err: SuperlativeError): boolean {
  return EMPTY_ERRORS.has(err.error) || err.error.startsWith('no_followers_data');
}

/** Turn a routed SuperlativeResult into one compact speakable sentence. */
function speakSuperlative(res: SuperlativeResult): string {
  const name = displayNameOf(res);
  if (res.metric === 'vitana_index_total') {
    return `${name} has the highest Vitana Index in the community right now — ${res.metric_value} points.`;
  }
  if (res.metric.startsWith('pillar_')) {
    const pillar = res.metric.slice('pillar_'.length);
    return `${name} leads the community on the ${pillar} pillar with a score of ${res.metric_value} points.`;
  }
  if (res.metric === 'first_member_registered') {
    const since = monthYearPhrase(res.profile?.member_since ?? null);
    return `${name} was the very first member of the community${since ? ` — a member since ${since}` : ''}.`;
  }
  if (res.metric === 'newest_member_registered') {
    return `${name} is our newest community member — they joined ${relativeJoinedPhrase(res.profile?.member_since ?? null)}.`;
  }
  if (res.metric === 'follower_count') {
    const n = Number(res.metric_value) || 0;
    return `${name} is the most followed member of the community with ${n} follower${n === 1 ? '' : 's'}.`;
  }
  return `${name} tops the community on ${res.metric.replace(/_/g, ' ')} (${res.metric_value}).`;
}

function superlativePayload(res: SuperlativeResult): Record<string, unknown> {
  return {
    metric: res.metric,
    metric_value: res.metric_value,
    metric_unit: res.metric_unit ?? null,
    display_name: displayNameOf(res),
    vitana_id: res.profile?.vitana_id ?? null,
    member_since: res.profile?.member_since ?? null,
    total_eligible: res.total_eligible,
  };
}

// ---------------------------------------------------------------------------
// get_highest_vitana_index
// ---------------------------------------------------------------------------

export async function tool_get_highest_vitana_index(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_highest_vitana_index', id);
  if (gate) return gate;
  try {
    const res = await getHighestVitanaIndex(sb, 1);
    if (!res.ok) {
      if (isEmptyState(res)) {
        return {
          ok: true,
          result: { available: false },
          text: 'No community member has a visible Vitana Index score yet — the leaderboard is still empty.',
        };
      }
      return { ok: false, error: res.error };
    }
    return { ok: true, result: superlativePayload(res), text: speakSuperlative(res) };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_highest_vitana_index failed' };
  }
}

// ---------------------------------------------------------------------------
// get_top_in_pillar
// ---------------------------------------------------------------------------

export async function tool_get_top_in_pillar(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_top_in_pillar', id);
  if (gate) return gate;
  const pillar = resolvePillar(args.pillar);
  if (!pillar) {
    return {
      ok: false,
      error: `get_top_in_pillar requires a pillar: ${VALID_PILLARS.join(', ')}.`,
    };
  }
  try {
    const res = await getTopInPillar(sb, pillar, 1);
    if (!res.ok) {
      if (isEmptyState(res)) {
        return {
          ok: true,
          result: { available: false, pillar },
          text: `No community member has a visible ${pillar} score yet.`,
        };
      }
      return { ok: false, error: res.error };
    }
    return { ok: true, result: { ...superlativePayload(res), pillar }, text: speakSuperlative(res) };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_top_in_pillar failed' };
  }
}

// ---------------------------------------------------------------------------
// get_first_member / get_newest_member
// ---------------------------------------------------------------------------

async function memberByRegistration(
  tool: 'get_first_member' | 'get_newest_member',
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate(tool, id);
  if (gate) return gate;
  try {
    const res = await getMemberByRegistration(sb, tool === 'get_first_member' ? 'first' : 'newest', 1);
    if (!res.ok) {
      if (isEmptyState(res)) {
        return {
          ok: true,
          result: { available: false },
          text: 'There are no visible community members yet.',
        };
      }
      return { ok: false, error: res.error };
    }
    return { ok: true, result: superlativePayload(res), text: speakSuperlative(res) };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : `${tool} failed` };
  }
}

export async function tool_get_first_member(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  return memberByRegistration('get_first_member', id, sb);
}

export async function tool_get_newest_member(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  return memberByRegistration('get_newest_member', id, sb);
}

// ---------------------------------------------------------------------------
// get_most_followed
// ---------------------------------------------------------------------------

export async function tool_get_most_followed(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_most_followed', id);
  if (gate) return gate;
  try {
    const res = await getMostFollowed(sb, 1);
    if (!res.ok) {
      if (isEmptyState(res)) {
        return {
          ok: true,
          result: { available: false },
          text: 'No one in the community has any followers yet.',
        };
      }
      return { ok: false, error: res.error };
    }
    return { ok: true, result: superlativePayload(res), text: speakSuperlative(res) };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_most_followed failed' };
  }
}

// ---------------------------------------------------------------------------
// ask_who_is — NL router for free-form "who is...?" superlative questions
// ---------------------------------------------------------------------------

export async function tool_ask_who_is(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('ask_who_is', id, true);
  if (gate) return gate;
  const query = String(args.query ?? args.question ?? '').trim();
  if (query.length < 2) {
    return { ok: false, error: 'ask_who_is requires a non-empty query.' };
  }

  // 1) Route through the superlatives NL router first.
  let clarifyText: string | null = null;
  try {
    const routed = await askWhoIs(sb, { question: query });
    if (routed.ok === true) {
      return {
        ok: true,
        result: { ...superlativePayload(routed), routed_to: routed.metric },
        text: speakSuperlative(routed),
      };
    }
    if (routed.ok === 'clarify') clarifyText = routed.question;
    // ok === false (e.g. empty leaderboard for the routed metric) also falls
    // through to the general member ranker below.
  } catch {
    /* router failure → try the ranker fallback */
  }

  // 2) Fall back to the same ranking pipeline find_community_member uses.
  try {
    const outcome = await findCommunityMember(sb, {
      viewer_user_id: id.user_id,
      viewer_tenant_id: id.tenant_id as string,
      query,
    });
    return {
      ok: true,
      result: {
        routed_to: 'find_community_member',
        vitana_id: outcome.result.vitana_id,
        display_name: outcome.result.display_name,
        match_recipe: outcome.result.match_recipe,
      },
      text: outcome.result.voice_summary,
    };
  } catch (err: unknown) {
    if (clarifyText) {
      return { ok: true, result: { routed_to: 'clarify' }, text: clarifyText };
    }
    return { ok: false, error: err instanceof Error ? err.message : 'ask_who_is failed' };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const SUPERLATIVES_TOOL_HANDLERS: Record<string, Handler> = {
  get_highest_vitana_index: tool_get_highest_vitana_index,
  get_top_in_pillar: tool_get_top_in_pillar,
  get_first_member: tool_get_first_member,
  get_newest_member: tool_get_newest_member,
  get_most_followed: tool_get_most_followed,
  ask_who_is: tool_ask_who_is,
};

export const SUPERLATIVES_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'get_highest_vitana_index',
    description: [
      'Get the community member with the highest Vitana Index right now.',
      'Returns their name and score; private profiles are never revealed.',
      'CALL WHEN the user asks: "who has the highest Vitana Index?",',
      '"who is the healthiest member?", "wer hat den höchsten Vitana Index?",',
      '"wer ist am gesündesten?".',
      'After the tool runs, read the returned text aloud (one sentence).',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_top_in_pillar',
    description: [
      'Get the community member with the top score in ONE Vitana Index pillar.',
      'pillar must be one of: nutrition, hydration, exercise, sleep, mental.',
      'CALL WHEN the user asks: "who has the best sleep?", "who is the',
      'fittest?", "wer schläft am besten?", "wer ist am fittesten?",',
      '"wer trinkt am meisten Wasser?".',
      'After the tool runs, read the returned text aloud (one sentence).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        pillar: {
          type: 'string',
          description: 'One of: nutrition, hydration, exercise, sleep, mental.',
        },
      },
      required: ['pillar'],
    },
  },
  {
    name: 'get_first_member',
    description: [
      'Get the very first (earliest-registered / OG) community member.',
      'CALL WHEN the user asks: "who was the first member?", "who is the',
      'longest-standing / OG member?", "wer war das erste Mitglied?",',
      '"wer ist am längsten dabei?".',
      'After the tool runs, read the returned text aloud (one sentence).',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_newest_member',
    description: [
      'Get the most recently joined community member.',
      'CALL WHEN the user asks: "who is the newest member?", "who just',
      'joined?", "wer ist das neueste Mitglied?", "wer ist gerade beigetreten?".',
      'After the tool runs, read the returned text aloud (one sentence).',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_most_followed',
    description: [
      'Get the community member with the most followers.',
      'CALL WHEN the user asks: "who has the most followers?", "who is the',
      'most popular member?", "wer hat die meisten Follower?", "wer ist am',
      'beliebtesten?".',
      'After the tool runs, read the returned text aloud (one sentence).',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ask_who_is',
    description: [
      'Answer ANY free-form "who is...?" superlative question about the',
      'community that the specific superlative tools above do not cover.',
      'Routes to the matching leaderboard (index, pillar, tenure, followers)',
      'or falls back to the general community-member ranking.',
      'CALL WHEN the user asks e.g.: "who is the most inspiring?", "who is',
      'the best runner?", "wer ist der/die inspirierendste?", "wer ist am',
      'aktivsten?". Pass the user\'s question verbatim as query.',
      'After the tool runs, read the returned text aloud, then stop.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The user\'s "who is...?" question, verbatim.',
        },
      },
      required: ['query'],
    },
  },
];
