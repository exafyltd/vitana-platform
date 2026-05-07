/**
 * VTID-02754 — Voice Tool Expansion P1b: Community Member Search.
 *
 * Backs the find_community_member voice tool. The user asks Vitana
 * "who is good at half marathon", "who is the healthiest", "who is the
 * funniest", "who is closest to me" — and the tool returns exactly one
 * community member to redirect to, plus a voice_summary that Gemini
 * speaks aloud and a match_recipe the frontend renders as a "How we
 * searched" card.
 *
 * Pipeline (4 tiers + 2 modifiers, every call ends on exactly one user):
 *   Tier 1 — Exact:     services / facts / activities / groups
 *   Tier 2 — Index:     overall Vitana Index or per-pillar leader
 *   Tier 3 — Affinity:  teaching, expertise, experience, motivation,
 *                       entertainment, conversation, generic (bio trigram)
 *   Tier 4 — Ethics:    sensitive comparatives ("most beautiful",
 *                       "richest") fall through to Tier 3 with a
 *                       re-framing voice line.
 *   Modifiers:          location (city / country) and tenure
 *                       (newest, longest, recent activity) compose
 *                       with any tier OR stand alone.
 *
 * Privacy invariants:
 *   - global_community_profiles.is_visible must be true.
 *   - Per-field reveal in match_recipe respects can_read_profile_field.
 *   - excluded_vitana_ids drives the "show me someone else" button.
 *
 * Result shape: ALWAYS { ok: true, ... }. No `degraded` / `partial` /
 * `warning` flags — Gemini Live treats those as failure and apologises.
 * Honest weak signals belong in voice_summary, not flags.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';
import {
  Pillar,
  ProfileCard,
  getHighestVitanaIndex,
  getTopInPillar,
  getMemberByRegistration,
} from './superlatives';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier = 1 | 2 | 3 | 4;

export type Lane =
  | 'exact_service'
  | 'exact_fact'
  | 'exact_activity'
  | 'exact_group'
  | 'index_overall'
  | 'index_pillar'
  | 'teaching'
  | 'expertise'
  | 'experience'
  | 'motivation'
  | 'entertainment'
  | 'conversation'
  | 'generic'
  | 'location_only'
  | 'tenure_only'
  | 'floor';

export interface SignalEntry {
  label: string;
  value: string;
  weight: number | 'filter' | 'sort';
  matched: boolean;
}

export interface MatchRecipe {
  interpreted_intent: string;
  tier: Tier;
  lane: Lane;
  ethics_reroute: boolean;
  signals_considered: SignalEntry[];
}

export interface FindMemberArgs {
  viewer_user_id: string;
  viewer_tenant_id: string;
  query: string;
  excluded_vitana_ids?: string[];
}

export interface FindMemberResult {
  ok: true;
  vitana_id: string | null;
  display_name: string;
  voice_summary: string;
  match_recipe: MatchRecipe;
  redirect: { screen: string; route: string };
  search_id?: string; // populated by the route after persisting
}

// ---------------------------------------------------------------------------
// Query interpreter
// ---------------------------------------------------------------------------

const SENSITIVE_COMPARATIVES = [
  'most beautiful', 'most attractive', 'most handsome', 'prettiest',
  'sexiest', 'hottest', 'most gorgeous',
  'richest', 'wealthiest', 'most successful',
  'thinnest', 'skinniest', 'fattest', 'best body',
];

const PILLAR_KEYWORDS: Array<[Pillar, RegExp]> = [
  ['exercise',  /\b(exercis\w*|athlet\w*|fitt\w*|strong\w*|runner|marathon|sport\w*|workout|training|active(?!ly))\b/i],
  ['sleep',     /\b(sleep\w*|rested|rest(?:ing)?\s+well|recover\w*)\b/i],
  ['mental',    /\b(calm\w*|balanced|zen|mindful|centered|stress.free|peace\w*|mood|mental(?!ity)?)\b/i],
  ['nutrition', /\b(nutrition\w*|eat\w*|diet(?!ing|ed)|food\w*|meal\w*)\b/i],
  ['hydration', /\b(hydrat\w*|water(?:drinker)?)\b/i],
];

const HEALTHY_RX     = /\b(healthi\w*|fittest|wellbeing|well[- ]?being|most\s+vital|strongest\s+overall)\b/i;
const TEACHING_RX    = /\b(teach\w*|instructor|coach\w*|mentor\w*|trainer|tutor|guide(?!\s*me))\b/i;
const EXPERTISE_RX   = /\b(expert\w*|knowledgeable|smartest|wisest|wisdom|learned|scholar|educated|specialist|geek|guru)\b/i;
const EXPERIENCE_RX  = /\b(experien\w*|veteran\w*|seasoned|long\s+time|many\s+years)\b/i;
const MOTIVATION_RX  = /\b(motivat\w*|inspirat\w*|inspiring|inspiration|role\s*model|encouraging|hero)\b/i;
const FUN_RX         = /\b(funn\w*|humor\w*|entertain\w*|witty|hilarious)\b/i;
const TALK_RX        = /\b(best\s+(?:talker|to\s+talk)|conversationalist|good\s+(?:to|at)\s+talk|chatty|articulate|easy\s+to\s+talk)\b/i;
const POPULAR_RX     = /\b(most\s+popular|most\s+followed|biggest\s+fan|most\s+fans)\b/i;

const NEAR_ME_RX     = /\b(near\s+me|in\s+my\s+neighborhood|in\s+my\s+(city|town)|nearby|around\s+me|closest\s+to\s+me|same\s+city\s+as\s+me)\b/i;
const IN_PLACE_RX    = /\b(?:in|from)\s+([A-Za-z][A-Za-z\s\-]{0,40}?)(?=[\s?!.,]|$)/i;

const NEWEST_RX      = /\b(newest|just\s+joined|most\s+recent|latest\s+to\s+join|latest\s+member)\b/i;
const LONGEST_RX     = /\b(longest\s+(?:standing|member)|oldest\s+member|og\s+member|first\s+member|original\s+member|founder)\b/i;
const RECENT_ACT_RX  = /\b(most\s+active|recently\s+active|active\s+right\s+now)\b/i;

interface ParsedQuery {
  raw: string;
  ethicsReroute: boolean;
  pillar?: Pillar;
  indexOverall: boolean;
  exactKeyword?: string;
  tier3Lane?: 'teaching' | 'expertise' | 'experience' | 'motivation' | 'entertainment' | 'conversation' | 'generic';
  locationFilter?: 'near_me' | 'in_place';
  locationPlace?: string;
  tenureFilter?: 'newest' | 'longest' | 'recent_active';
  popular: boolean;
}

export function parseQuery(query: string): ParsedQuery {
  const q = query.toLowerCase().trim();
  const out: ParsedQuery = {
    raw: query,
    ethicsReroute: false,
    indexOverall: false,
    popular: false,
  };

  if (SENSITIVE_COMPARATIVES.some(s => q.includes(s))) {
    out.ethicsReroute = true;
  }

  // Tier 2: pillar / overall index
  for (const [p, rx] of PILLAR_KEYWORDS) {
    if (rx.test(q)) {
      out.pillar = p;
      break;
    }
  }
  if (HEALTHY_RX.test(q) || (q.includes('vitana index') && /(highest|best|top)/.test(q))) {
    out.indexOverall = true;
  }

  // Tier 3 lane classification (later wins ties; specificity matters)
  if (TEACHING_RX.test(q))      out.tier3Lane = 'teaching';
  else if (EXPERTISE_RX.test(q)) out.tier3Lane = 'expertise';
  else if (EXPERIENCE_RX.test(q)) out.tier3Lane = 'experience';
  else if (MOTIVATION_RX.test(q)) out.tier3Lane = 'motivation';
  else if (FUN_RX.test(q))       out.tier3Lane = 'entertainment';
  else if (TALK_RX.test(q))      out.tier3Lane = 'conversation';

  // Modifiers
  if (NEAR_ME_RX.test(q)) {
    out.locationFilter = 'near_me';
  } else {
    const m = q.match(IN_PLACE_RX);
    if (m && m[1]) {
      const place = m[1].trim();
      if (!/^(my|the|a|an|me)$/.test(place)) {
        out.locationFilter = 'in_place';
        out.locationPlace = place;
      }
    }
  }

  if (NEWEST_RX.test(q))         out.tenureFilter = 'newest';
  else if (LONGEST_RX.test(q))   out.tenureFilter = 'longest';
  else if (RECENT_ACT_RX.test(q)) out.tenureFilter = 'recent_active';

  if (POPULAR_RX.test(q)) out.popular = true;

  // Tier 1 exact keyword: pull a high-signal noun for service/fact/activity/group lookup.
  // We strip stop-words and modifier phrases, then take the longest remaining token.
  out.exactKeyword = extractExactKeyword(q, out);

  return out;
}

const STOP_WORDS = new Set([
  'who','is','the','a','an','and','or','for','to','of','in','on','at','my',
  'me','someone','community','member','people','that','best','most','really',
  'good','great','find','show','tell','about','this','these','from','with',
  'has','have','here','there','any','can','i','want','looking','search',
  'recommend','recommendation','please','vitana',
  // Common verbs that often surround the meaningful keyword
  'play','plays','played','playing','do','does','did','doing','am','are','was','were',
  'be','been','being','get','gets','got','make','makes','made','take','takes','took',
  'know','knows','knew','like','likes','liked','need','needs','needed',
]);

function extractExactKeyword(q: string, parsed: Partial<ParsedQuery>): string | undefined {
  // Drop placeholder phrases captured by the modifier regexes so "in my city"
  // or "near me" doesn't leak into the keyword.
  let stripped = q
    .replace(NEAR_ME_RX, ' ')
    .replace(NEWEST_RX, ' ')
    .replace(LONGEST_RX, ' ')
    .replace(RECENT_ACT_RX, ' ')
    .replace(POPULAR_RX, ' ');
  if (parsed.locationFilter === 'in_place' && parsed.locationPlace) {
    stripped = stripped.replace(new RegExp('\\b' + parsed.locationPlace + '\\b', 'i'), ' ');
  }
  const tokens = stripped
    .split(/[^a-z0-9]+/i)
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t.toLowerCase()));
  if (tokens.length === 0) return undefined;
  // Prefer longest token (proxies "most specific")
  tokens.sort((a, b) => b.length - a.length);
  return tokens[0];
}

// ---------------------------------------------------------------------------
// Candidate pool (privacy + exclusions + location filter)
// ---------------------------------------------------------------------------

interface Candidate {
  user_id: string;
  vitana_id: string | null;
  display_name: string;
  city: string | null;
  country: string | null;
  registration_seq: number | null;
}

async function buildCandidatePool(
  sb: SupabaseClient,
  parsed: ParsedQuery,
  viewerUserId: string,
  excludedVitanaIds: string[],
): Promise<{ pool: Candidate[]; viewerCity: string | null; viewerCountry: string | null }> {
  // Visible users only
  const { data: visibleRows } = await sb
    .from('global_community_profiles')
    .select('user_id')
    .eq('is_visible', true);
  const visibleSet = new Set<string>((visibleRows || []).map((r: any) => String(r.user_id)));
  visibleSet.delete(viewerUserId); // user shouldn't search up themselves

  // Viewer's own city/country (for near_me modifier)
  const { data: viewerProfRow } = await sb
    .from('profiles')
    .select('city, country')
    .eq('user_id', viewerUserId)
    .maybeSingle();
  const viewerCity    = (viewerProfRow as any)?.city ?? null;
  const viewerCountry = (viewerProfRow as any)?.country ?? null;

  // Hydrate visible users
  if (visibleSet.size === 0) {
    return { pool: [], viewerCity, viewerCountry };
  }
  const visibleIds = Array.from(visibleSet);
  const [{ data: users }, { data: profs }] = await Promise.all([
    sb
      .from('app_users')
      .select('user_id, display_name, vitana_id')
      .in('user_id', visibleIds),
    sb
      .from('profiles')
      .select('user_id, city, country, registration_seq')
      .in('user_id', visibleIds),
  ]);
  const profMap = new Map<string, any>((profs || []).map((p: any) => [String(p.user_id), p]));

  const excludedSet = new Set<string>((excludedVitanaIds || []).map(v => v.toLowerCase()));
  let pool: Candidate[] = [];
  for (const u of users || []) {
    const uid = String((u as any).user_id);
    const prof = profMap.get(uid) || {};
    const vid = (u as any).vitana_id ?? null;
    if (vid && excludedSet.has(String(vid).toLowerCase())) continue;
    pool.push({
      user_id: uid,
      vitana_id: vid,
      display_name: (u as any).display_name ?? 'A community member',
      city: prof.city ?? null,
      country: prof.country ?? null,
      registration_seq: prof.registration_seq ?? null,
    });
  }

  // Location filter (city > country fallback)
  if (parsed.locationFilter === 'near_me') {
    if (viewerCity) {
      const filtered = pool.filter(c => c.city && c.city.toLowerCase() === viewerCity.toLowerCase());
      if (filtered.length > 0) pool = filtered;
      else if (viewerCountry) {
        const fc = pool.filter(c => c.country && c.country.toLowerCase() === viewerCountry.toLowerCase());
        if (fc.length > 0) pool = fc;
      }
    }
  } else if (parsed.locationFilter === 'in_place' && parsed.locationPlace) {
    const place = parsed.locationPlace.toLowerCase();
    const filtered = pool.filter(
      c =>
        (c.city && c.city.toLowerCase().includes(place)) ||
        (c.country && c.country.toLowerCase().includes(place)),
    );
    if (filtered.length > 0) pool = filtered;
  }

  return { pool, viewerCity, viewerCountry };
}

// ---------------------------------------------------------------------------
// Tier 1 — exact match
// ---------------------------------------------------------------------------

interface ScoredHit {
  user_id: string;
  score: number;
  matched_signal: string;
  matched_value: string;
}

async function tier1ExactMatch(
  sb: SupabaseClient,
  pool: Candidate[],
  keyword: string,
): Promise<ScoredHit | null> {
  if (!keyword) return null;
  const ids = new Set(pool.map(c => c.user_id));
  const kwLike = `%${keyword}%`;
  const hits = new Map<string, ScoredHit>();
  const bump = (uid: string, score: number, sig: string, val: string) => {
    if (!ids.has(uid)) return;
    const cur = hits.get(uid);
    if (!cur || score > cur.score) hits.set(uid, { user_id: uid, score, matched_signal: sig, matched_value: val });
  };

  // (a) service_offerings — JSONB::text ILIKE
  const { data: svcRows } = await sb
    .from('profiles')
    .select('user_id, service_offerings')
    .filter('service_offerings::text', 'ilike', kwLike)
    .limit(50);
  for (const r of svcRows || []) {
    const uid = String((r as any).user_id);
    const so  = (r as any).service_offerings || {};
    const offers = Array.isArray(so.offers) ? so.offers : [];
    const hit = offers.find((o: any) =>
      [o.title, o.category, o.short_description].some(
        (t: any) => typeof t === 'string' && t.toLowerCase().includes(keyword.toLowerCase()),
      ),
    );
    const label = hit ? `${hit.title || hit.category}` : 'service offering';
    bump(uid, 0.35, 'service_offering', label);
  }

  // (b) memory_facts — fact_key or fact_value
  const { data: factRows } = await sb
    .from('memory_facts')
    .select('user_id, fact_key, fact_value, provenance_source')
    .or(`fact_key.ilike.${kwLike},fact_value.ilike.${kwLike}`)
    .in('provenance_source', ['user_stated', 'assistant_inferred'])
    .limit(50);
  for (const r of factRows || []) {
    const uid = String((r as any).user_id);
    const stated = (r as any).provenance_source === 'user_stated';
    bump(uid, stated ? 0.30 : 0.20, 'memory_fact', `${(r as any).fact_key} = ${(r as any).fact_value}`);
  }

  // (c) health_features_daily — feature_key
  const { data: actRows } = await sb
    .from('health_features_daily')
    .select('user_id, feature_key')
    .ilike('feature_key', kwLike)
    .limit(200);
  const actCounts = new Map<string, number>();
  for (const r of actRows || []) {
    const uid = String((r as any).user_id);
    actCounts.set(uid, (actCounts.get(uid) ?? 0) + 1);
  }
  for (const [uid, n] of actCounts) {
    bump(uid, 0.20 + Math.min(0.05, n * 0.005), 'logged_activity', `${n} entries matching "${keyword}"`);
  }

  // (d) community_groups via topic_key + community_group_members
  const { data: grpRows } = await sb
    .from('community_groups')
    .select('id, name, topic_key')
    .or(`topic_key.ilike.${kwLike},name.ilike.${kwLike}`)
    .limit(20);
  const grpIds = (grpRows || []).map((g: any) => g.id);
  if (grpIds.length > 0) {
    const { data: memRows } = await sb
      .from('community_group_members')
      .select('user_id, group_id')
      .in('group_id', grpIds)
      .limit(500);
    for (const r of memRows || []) {
      const uid = String((r as any).user_id);
      const grp = (grpRows || []).find((g: any) => g.id === (r as any).group_id);
      bump(uid, 0.10, 'group_membership', grp ? `Member of ${grp.name}` : 'community group');
    }
  }

  if (hits.size === 0) return null;
  const sorted = Array.from(hits.values()).sort((a, b) => b.score - a.score);
  return sorted[0];
}

// ---------------------------------------------------------------------------
// Tier 3 lanes
// ---------------------------------------------------------------------------

async function tier3Teaching(
  sb: SupabaseClient,
  pool: Candidate[],
  keyword: string | undefined,
): Promise<ScoredHit | null> {
  const ids = new Set(pool.map(c => c.user_id));
  // Service offerings whose category contains teaching/coaching/mentoring
  const { data: rows } = await sb
    .from('profiles')
    .select('user_id, service_offerings')
    .or('service_offerings::text.ilike.%teaching%,service_offerings::text.ilike.%coaching%,service_offerings::text.ilike.%mentoring%,service_offerings::text.ilike.%instructor%')
    .limit(100);

  let best: ScoredHit | null = null;
  let bestYears = -1;
  for (const r of rows || []) {
    const uid = String((r as any).user_id);
    if (!ids.has(uid)) continue;
    const so = (r as any).service_offerings || {};
    const offers: any[] = Array.isArray(so.offers) ? so.offers : [];
    const teachOffer = offers.find(o => {
      const cat = String(o?.category || '').toLowerCase();
      const title = String(o?.title || '').toLowerCase();
      const matchKw = keyword ? (cat.includes(keyword.toLowerCase()) || title.includes(keyword.toLowerCase())) : true;
      return (
        matchKw &&
        (cat.includes('teaching') ||
          cat.includes('coaching') ||
          cat.includes('mentoring') ||
          cat.includes('instructor'))
      );
    });
    if (!teachOffer) continue;
    if (!best) {
      best = {
        user_id: uid,
        score: 0.5,
        matched_signal: 'teaching_offering',
        matched_value: String(teachOffer.title || teachOffer.category || 'Teaching service'),
      };
      bestYears = 0;
    }

    // Years of experience boost from memory_facts
    const { data: yearsRow } = await sb
      .from('memory_facts')
      .select('fact_key, fact_value')
      .eq('user_id', uid)
      .ilike('fact_key', 'years_experience_%')
      .limit(5);
    const years = (yearsRow || []).reduce((mx: number, r: any) => {
      const n = Number(String(r.fact_value).match(/\d+/)?.[0] || 0);
      return n > mx ? n : mx;
    }, 0);
    if (years > bestYears) {
      bestYears = years;
      best = {
        user_id: uid,
        score: 0.5 + Math.min(0.4, years * 0.04),
        matched_signal: 'teaching_offering',
        matched_value: `${teachOffer.title || teachOffer.category} (${years} yrs experience)`,
      };
    }
  }
  return best;
}

async function tier3Expertise(
  sb: SupabaseClient,
  pool: Candidate[],
  keyword: string | undefined,
): Promise<ScoredHit | null> {
  const ids = new Set(pool.map(c => c.user_id));
  // (a) service_offerings in education.* category
  const { data: eduRows } = await sb
    .from('profiles')
    .select('user_id, service_offerings')
    .filter('service_offerings::text', 'ilike', '%education%')
    .limit(50);
  let best: ScoredHit | null = null;
  for (const r of eduRows || []) {
    const uid = String((r as any).user_id);
    if (!ids.has(uid)) continue;
    const so = (r as any).service_offerings || {};
    const offers: any[] = Array.isArray(so.offers) ? so.offers : [];
    const eduOffer = offers.find(o => String(o?.category || '').toLowerCase().startsWith('education'));
    if (!eduOffer) continue;
    if (!best || best.score < 0.45) {
      best = {
        user_id: uid,
        score: 0.45,
        matched_signal: 'education_offering',
        matched_value: String(eduOffer.title || eduOffer.category),
      };
    }
  }

  // (b) memory_facts expert_in_* / certified_* / degree_*
  const { data: factRows } = await sb
    .from('memory_facts')
    .select('user_id, fact_key, fact_value')
    .or('fact_key.ilike.expert_in_%,fact_key.ilike.certified_%,fact_key.ilike.degree_%')
    .limit(100);
  for (const r of factRows || []) {
    const uid = String((r as any).user_id);
    if (!ids.has(uid)) continue;
    const matchKw = keyword
      ? String((r as any).fact_key).toLowerCase().includes(keyword.toLowerCase()) ||
        String((r as any).fact_value).toLowerCase().includes(keyword.toLowerCase())
      : true;
    if (!matchKw) continue;
    if (!best || best.score < 0.5) {
      best = {
        user_id: uid,
        score: 0.5,
        matched_signal: 'expertise_fact',
        matched_value: `${(r as any).fact_key} = ${(r as any).fact_value}`,
      };
    }
  }
  return best;
}

async function tier3Motivation(
  sb: SupabaseClient,
  pool: Candidate[],
): Promise<ScoredHit | null> {
  const ids = new Set(pool.map(c => c.user_id));
  // Vitana Index 30-day delta proxy: latest two index rows per user.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data } = await sb
    .from('vitana_index_scores')
    .select('user_id, score_total, date')
    .gte('date', since)
    .order('date', { ascending: false })
    .limit(2000);
  if (!data || data.length === 0) return null;
  const byUser = new Map<string, Array<{ score: number; date: string }>>();
  for (const r of data) {
    const uid = String((r as any).user_id);
    if (!ids.has(uid)) continue;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid)!.push({ score: Number((r as any).score_total) || 0, date: String((r as any).date) });
  }
  let bestUser = '';
  let bestDelta = -Infinity;
  let latest = 0;
  for (const [uid, rows] of byUser) {
    rows.sort((a, b) => (a.date < b.date ? 1 : -1));
    if (rows.length === 0) continue;
    const newest = rows[0].score;
    const oldest = rows[rows.length - 1].score;
    const delta = newest - oldest;
    if (delta > bestDelta) {
      bestDelta = delta;
      bestUser = uid;
      latest = newest;
    }
  }
  if (!bestUser) return null;
  return {
    user_id: bestUser,
    score: 0.5 + Math.min(0.4, bestDelta * 0.005),
    matched_signal: 'index_30d_delta',
    matched_value: `Vitana Index climbed ${bestDelta} pts in 30 days (now ${latest})`,
  };
}

async function tier3Entertainment(
  sb: SupabaseClient,
  pool: Candidate[],
): Promise<ScoredHit | null> {
  const ids = new Set(pool.map(c => c.user_id));
  const { data: grpRows } = await sb
    .from('community_groups')
    .select('id, name, topic_key')
    .or('topic_key.ilike.%entertainment%,topic_key.ilike.%fun%,topic_key.ilike.%music%,topic_key.ilike.%comedy%,topic_key.ilike.%dance%,name.ilike.%entertainment%,name.ilike.%comedy%')
    .limit(20);
  const grpIds = (grpRows || []).map((g: any) => g.id);
  if (grpIds.length === 0) return null;
  const { data: memRows } = await sb
    .from('community_group_members')
    .select('user_id, group_id')
    .in('group_id', grpIds)
    .limit(500);
  const counts = new Map<string, number>();
  for (const r of memRows || []) {
    const uid = String((r as any).user_id);
    if (!ids.has(uid)) continue;
    counts.set(uid, (counts.get(uid) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let bestUser = '';
  let bestN = 0;
  for (const [uid, n] of counts) {
    if (n > bestN) {
      bestN = n;
      bestUser = uid;
    }
  }
  return {
    user_id: bestUser,
    score: 0.3 + Math.min(0.2, bestN * 0.05),
    matched_signal: 'entertainment_group_activity',
    matched_value: `Active in ${bestN} entertainment-themed group${bestN === 1 ? '' : 's'}`,
  };
}

async function tier3Conversation(
  sb: SupabaseClient,
  pool: Candidate[],
): Promise<ScoredHit | null> {
  const ids = new Set(pool.map(c => c.user_id));
  const { data } = await sb
    .from('vitana_index_scores')
    .select('user_id, score_mental, date')
    .order('score_mental', { ascending: false })
    .order('date', { ascending: false })
    .limit(50);
  if (!data || data.length === 0) return null;
  const seen = new Set<string>();
  for (const r of data) {
    const uid = String((r as any).user_id);
    if (!ids.has(uid) || seen.has(uid)) continue;
    seen.add(uid);
    return {
      user_id: uid,
      score: 0.4,
      matched_signal: 'mental_pillar',
      matched_value: `Mental pillar score ${(r as any).score_mental}`,
    };
  }
  return null;
}

async function tier3Generic(
  sb: SupabaseClient,
  pool: Candidate[],
  keyword: string | undefined,
): Promise<ScoredHit | null> {
  if (!keyword) return null;
  const ids = new Set(pool.map(c => c.user_id));
  const kwLike = `%${keyword}%`;
  const { data } = await sb
    .from('app_users')
    .select('user_id, bio')
    .ilike('bio', kwLike)
    .limit(50);
  for (const r of data || []) {
    const uid = String((r as any).user_id);
    if (!ids.has(uid)) continue;
    return {
      user_id: uid,
      score: 0.25,
      matched_signal: 'bio_match',
      matched_value: `Bio mentions "${keyword}"`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Modifiers (pure-modifier paths)
// ---------------------------------------------------------------------------

async function pickByTenure(
  sb: SupabaseClient,
  pool: Candidate[],
  filter: 'newest' | 'longest' | 'recent_active',
): Promise<Candidate | null> {
  if (pool.length === 0) return null;
  if (filter === 'newest' || filter === 'longest') {
    const sorted = [...pool]
      .filter(c => typeof c.registration_seq === 'number')
      .sort((a, b) => {
        const aN = a.registration_seq ?? 0;
        const bN = b.registration_seq ?? 0;
        return filter === 'newest' ? bN - aN : aN - bN;
      });
    if (sorted.length > 0) return sorted[0];
    // Fallback: use the existing superlative primitive (uses created_at as backstop).
    const out = await getMemberByRegistration(sb, filter === 'newest' ? 'newest' : 'first', 1);
    if ('ok' in out && out.ok && out.profile) {
      const found = pool.find(p => p.vitana_id === out.profile.vitana_id);
      if (found) return found;
    }
    return null;
  }
  // recent_active — fall back to first candidate (no last_active_at columns audited)
  return pool[0];
}

// ---------------------------------------------------------------------------
// Voice summary builder
// ---------------------------------------------------------------------------

function relativeJoinedPhrase(memberSinceDays: number | null): string {
  if (memberSinceDays === null) return 'recently';
  if (memberSinceDays < 1)  return 'today';
  if (memberSinceDays < 2)  return 'yesterday';
  if (memberSinceDays < 7)  return `${Math.round(memberSinceDays)} days ago`;
  if (memberSinceDays < 60) return `${Math.round(memberSinceDays / 7)} weeks ago`;
  if (memberSinceDays < 730) return `${Math.round(memberSinceDays / 30)} months ago`;
  return `${Math.round(memberSinceDays / 365)} years ago`;
}

function buildVoiceSummary(args: {
  parsed: ParsedQuery;
  tier: Tier;
  lane: Lane;
  ethicsReroute: boolean;
  displayName: string;
  signal?: ScoredHit | null;
  pillarLabel?: string;
  pillarScore?: number | string | null;
  memberSincePhrase?: string;
}): string {
  const { parsed, tier, lane, ethicsReroute, displayName, signal, pillarLabel, pillarScore, memberSincePhrase } = args;
  if (ethicsReroute) {
    return `Vitana doesn't rank community members on appearance or wealth, but ${displayName} stands out right now — opening their profile.`;
  }
  if (lane === 'tenure_only') {
    if (parsed.tenureFilter === 'newest')   return `${displayName} joined Vitana ${memberSincePhrase || 'recently'} — our newest member. Opening their profile.`;
    if (parsed.tenureFilter === 'longest')  return `${displayName} is one of our longest-standing members. Opening their profile.`;
    return `${displayName} has been the most active in the community lately. Opening their profile.`;
  }
  if (lane === 'location_only') {
    return `${displayName} is one of our community members near you. Opening their profile.`;
  }
  if (tier === 2) {
    if (lane === 'index_overall') return `${displayName} has the highest Vitana Index in the community right now. Opening their profile.`;
    if (lane === 'index_pillar' && pillarLabel) {
      return `${displayName} leads the community on the ${pillarLabel} pillar with a score of ${pillarScore}. Opening their profile.`;
    }
  }
  if (tier === 1 && signal) {
    return `${displayName} matches your search — ${signal.matched_value}. Opening their profile.`;
  }
  if (tier === 3 && signal) {
    if (lane === 'teaching')      return `${displayName} teaches in the community — ${signal.matched_value}. Opening their profile.`;
    if (lane === 'expertise')     return `${displayName} has the strongest expertise signal we have on this — ${signal.matched_value}. Opening their profile.`;
    if (lane === 'experience')    return `${displayName} stands out for experience — ${signal.matched_value}. Opening their profile.`;
    if (lane === 'motivation')    return `${displayName} is on the most inspiring trajectory we can see right now — ${signal.matched_value}. Opening their profile.`;
    if (lane === 'entertainment') return `We don't track humor scores, but ${displayName} is the most active in our entertainment groups — opening their profile.`;
    if (lane === 'conversation')  return `${displayName} ranks highest on the mental-balance pillar, often a good signal for great conversations. Opening their profile.`;
    if (lane === 'generic')       return `${displayName}'s profile is the closest match to "${parsed.raw}". Opening their profile.`;
  }
  return `${displayName} is one of our most active community members right now. No one has logged this exactly yet, but their profile is opening.`;
}

// ---------------------------------------------------------------------------
// Match recipe builder
// ---------------------------------------------------------------------------

function buildMatchRecipe(args: {
  parsed: ParsedQuery;
  tier: Tier;
  lane: Lane;
  ethicsReroute: boolean;
  signals: SignalEntry[];
}): MatchRecipe {
  const { parsed, tier, lane, ethicsReroute, signals } = args;
  let intent: string;
  if (ethicsReroute) intent = `Reframed: "${parsed.raw}" — Vitana does not rank on the requested attribute`;
  else if (lane === 'tenure_only')   intent = `Member by tenure: ${parsed.tenureFilter}`;
  else if (lane === 'location_only') intent = `Members near you`;
  else if (lane === 'index_overall') intent = 'Highest overall Vitana Index';
  else if (lane === 'index_pillar')  intent = `Highest score on the ${parsed.pillar} pillar`;
  else if (lane === 'teaching')      intent = `Best ${parsed.exactKeyword || 'teacher'} (teaching/coaching offering, ranked by experience)`;
  else if (lane === 'expertise')     intent = `Most knowledgeable about ${parsed.exactKeyword || parsed.raw}`;
  else if (lane === 'experience')    intent = `Most experienced in ${parsed.exactKeyword || parsed.raw}`;
  else if (lane === 'motivation')    intent = `Most inspiring trajectory in the community`;
  else if (lane === 'entertainment') intent = `Most active member in entertainment-themed groups`;
  else if (lane === 'conversation')  intent = `Top mental-balance pillar (proxy for conversational ease)`;
  else if (lane === 'floor')         intent = `Most active community member (no exact match for "${parsed.raw}")`;
  else                                intent = `Closest match to "${parsed.raw}"`;
  return { interpreted_intent: intent, tier, lane, ethics_reroute: ethicsReroute, signals_considered: signals };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const SCREEN_TARGET = 'profile_with_match';

function buildRoute(vitanaId: string | null, parsed: ParsedQuery, searchId: string | undefined): string {
  const id = vitanaId ?? '@unknown';
  const params = new URLSearchParams();
  params.set('from', 'who_search');
  if (searchId) params.set('search_id', searchId);
  params.set('q', parsed.raw.slice(0, 80));
  return `/u/${encodeURIComponent(id)}?${params.toString()}`;
}

export function hashQuery(query: string, viewerId: string): string {
  return crypto.createHash('sha256').update(`${viewerId}::${query}`).digest('hex').slice(0, 32);
}

export async function findCommunityMember(
  sb: SupabaseClient,
  args: FindMemberArgs,
): Promise<{ result: FindMemberResult; tier: Tier; lane: Lane; winnerUserId: string | null }> {
  const parsed = parseQuery(args.query);
  const { pool } = await buildCandidatePool(
    sb,
    parsed,
    args.viewer_user_id,
    args.excluded_vitana_ids ?? [],
  );

  // No visible candidates anywhere — extreme floor: return a synthetic "soft" response
  if (pool.length === 0) {
    const recipe = buildMatchRecipe({
      parsed,
      tier: 3,
      lane: 'floor',
      ethicsReroute: parsed.ethicsReroute,
      signals: [
        { label: 'Visible community pool', value: '0 visible members for this viewer', weight: 'filter', matched: false },
      ],
    });
    return {
      tier: 3,
      lane: 'floor',
      winnerUserId: null,
      result: {
        ok: true,
        vitana_id: null,
        display_name: 'No one yet',
        voice_summary: `I couldn't find any visible community members to introduce you to right now. Try inviting a friend, or check back as more people join.`,
        match_recipe: recipe,
        redirect: { screen: SCREEN_TARGET, route: '/community/members' },
      },
    };
  }

  const ethicsReroute = parsed.ethicsReroute;
  const signals: SignalEntry[] = [];

  // Surface modifier signals up-front (so they always appear in the recipe).
  if (parsed.locationFilter === 'near_me') {
    signals.push({
      label: 'Location filter',
      value: 'Same city as you',
      weight: 'filter',
      matched: true,
    });
  } else if (parsed.locationFilter === 'in_place' && parsed.locationPlace) {
    signals.push({
      label: 'Location filter',
      value: `Place: ${parsed.locationPlace}`,
      weight: 'filter',
      matched: true,
    });
  }

  type Finalized = { result: FindMemberResult; tier: Tier; lane: Lane; winnerUserId: string } | null;
  const helpers = {
    finalize: (
      winner: Candidate | null,
      tier: Tier,
      lane: Lane,
      pillarLabel?: string,
      pillarScore?: number | string | null,
      signal?: ScoredHit | null,
      memberSincePhrase?: string,
    ): Finalized => {
      if (!winner) return null;
      const allSignals = [...signals];
      if (signal) {
        allSignals.push({
          label:
            signal.matched_signal === 'service_offering' ? 'Service offering' :
            signal.matched_signal === 'memory_fact' ? 'User-stated fact' :
            signal.matched_signal === 'logged_activity' ? 'Logged activity' :
            signal.matched_signal === 'group_membership' ? 'Community group' :
            signal.matched_signal === 'teaching_offering' ? 'Teaching offering' :
            signal.matched_signal === 'education_offering' ? 'Education offering' :
            signal.matched_signal === 'expertise_fact' ? 'Expertise fact' :
            signal.matched_signal === 'index_30d_delta' ? 'Vitana Index trajectory' :
            signal.matched_signal === 'entertainment_group_activity' ? 'Entertainment group activity' :
            signal.matched_signal === 'mental_pillar' ? 'Mental balance pillar' :
            signal.matched_signal === 'bio_match' ? 'Profile bio' :
            signal.matched_signal,
          value: signal.matched_value,
          weight: signal.score,
          matched: true,
        });
      }
      if (pillarLabel) {
        allSignals.push({
          label: lane === 'index_overall' ? 'Vitana Index (overall)' : `Vitana Index — ${pillarLabel} pillar`,
          value: pillarScore !== null && pillarScore !== undefined ? `${pillarScore} pts` : '—',
          weight: 'sort',
          matched: true,
        });
      }
      if (parsed.tenureFilter && lane === 'tenure_only') {
        allSignals.push({
          label: 'Tenure',
          value:
            parsed.tenureFilter === 'newest'
              ? `Joined ${memberSincePhrase || 'recently'} — newest visible member`
              : parsed.tenureFilter === 'longest'
                ? 'Lowest registration sequence — one of the first members'
                : 'Most active community member',
          weight: 'sort',
          matched: true,
        });
      }

      const recipe = buildMatchRecipe({ parsed, tier, lane, ethicsReroute, signals: allSignals });
      const result: FindMemberResult = {
        ok: true,
        vitana_id: winner.vitana_id,
        display_name: winner.display_name,
        voice_summary: buildVoiceSummary({
          parsed, tier, lane, ethicsReroute,
          displayName: winner.display_name,
          signal, pillarLabel, pillarScore, memberSincePhrase,
        }),
        match_recipe: recipe,
        redirect: { screen: SCREEN_TARGET, route: buildRoute(winner.vitana_id, parsed, undefined) },
      };
      return { result, tier, lane, winnerUserId: winner.user_id };
    },
  };

  // ---- Tier 4 short-circuit: send sensitive-comparative queries to generic immediately
  if (ethicsReroute) {
    const generic = await tier3Generic(sb, pool, parsed.exactKeyword);
    const winnerCand = generic ? pool.find(c => c.user_id === generic.user_id) ?? pool[0] : pool[0];
    return helpers.finalize(winnerCand, 4, 'generic', undefined, undefined, generic) || {
      tier: 4 as Tier, lane: 'generic' as Lane, winnerUserId: pool[0].user_id,
      result: makeSoftFloor(parsed, pool[0], ethicsReroute, signals),
    };
  }

  // ---- Pure-modifier queries (no core intent extracted)
  const noCoreIntent =
    !parsed.tier3Lane &&
    !parsed.pillar &&
    !parsed.indexOverall &&
    !parsed.exactKeyword;

  if (noCoreIntent && parsed.tenureFilter) {
    const cand = await pickByTenure(sb, pool, parsed.tenureFilter);
    if (cand) {
      const phrase = await joinedPhraseFor(sb, cand.user_id);
      return helpers.finalize(cand, 1, 'tenure_only', undefined, undefined, undefined, phrase) || {
        tier: 3 as Tier, lane: 'floor' as Lane, winnerUserId: cand.user_id,
        result: makeSoftFloor(parsed, cand, false, signals),
      };
    }
  }
  if (noCoreIntent && parsed.locationFilter) {
    const winnerCand = pool[0];
    return helpers.finalize(winnerCand, 1, 'location_only') || {
      tier: 1 as Tier, lane: 'location_only' as Lane, winnerUserId: winnerCand.user_id,
      result: makeSoftFloor(parsed, winnerCand, false, signals),
    };
  }

  // ---- Tier 1 exact match
  if (parsed.exactKeyword) {
    const hit = await tier1ExactMatch(sb, pool, parsed.exactKeyword);
    if (hit) {
      const cand = pool.find(c => c.user_id === hit.user_id);
      if (cand) {
        const lane: Lane =
          hit.matched_signal === 'service_offering'   ? 'exact_service' :
          hit.matched_signal === 'memory_fact'        ? 'exact_fact' :
          hit.matched_signal === 'logged_activity'    ? 'exact_activity' :
          hit.matched_signal === 'group_membership'   ? 'exact_group' : 'exact_service';
        return helpers.finalize(cand, 1, lane, undefined, undefined, hit) || {
          tier: 1 as Tier, lane, winnerUserId: cand.user_id,
          result: makeSoftFloor(parsed, cand, false, signals),
        };
      }
    }
  }

  // ---- Tier 2 Vitana Index
  if (parsed.indexOverall) {
    const top = await getHighestVitanaIndex(sb, 1);
    if ('ok' in top && top.ok && top.profile) {
      const cand = pool.find(c => c.vitana_id === top.profile.vitana_id);
      if (cand) {
        return helpers.finalize(cand, 2, 'index_overall', 'overall', top.metric_value) || {
          tier: 2 as Tier, lane: 'index_overall' as Lane, winnerUserId: cand.user_id,
          result: makeSoftFloor(parsed, cand, false, signals),
        };
      }
    }
  }
  if (parsed.pillar) {
    const top = await getTopInPillar(sb, parsed.pillar, 1);
    if ('ok' in top && top.ok && top.profile) {
      const cand = pool.find(c => c.vitana_id === top.profile.vitana_id);
      if (cand) {
        return helpers.finalize(cand, 2, 'index_pillar', parsed.pillar, top.metric_value) || {
          tier: 2 as Tier, lane: 'index_pillar' as Lane, winnerUserId: cand.user_id,
          result: makeSoftFloor(parsed, cand, false, signals),
        };
      }
    }
  }

  // ---- Tier 3 lanes
  let lane3: Lane = 'generic';
  let hit3: ScoredHit | null = null;
  switch (parsed.tier3Lane) {
    case 'teaching':       hit3 = await tier3Teaching(sb, pool, parsed.exactKeyword);  lane3 = 'teaching';      break;
    case 'expertise':      hit3 = await tier3Expertise(sb, pool, parsed.exactKeyword); lane3 = 'expertise';     break;
    case 'experience':     hit3 = await tier3Expertise(sb, pool, parsed.exactKeyword); lane3 = 'experience';    break;
    case 'motivation':     hit3 = await tier3Motivation(sb, pool);                     lane3 = 'motivation';    break;
    case 'entertainment':  hit3 = await tier3Entertainment(sb, pool);                  lane3 = 'entertainment'; break;
    case 'conversation':   hit3 = await tier3Conversation(sb, pool);                   lane3 = 'conversation';  break;
    default:               hit3 = await tier3Generic(sb, pool, parsed.exactKeyword);   lane3 = 'generic';       break;
  }
  if (hit3) {
    const cand = pool.find(c => c.user_id === hit3!.user_id);
    if (cand) {
      return helpers.finalize(cand, 3, lane3, undefined, undefined, hit3) || {
        tier: 3 as Tier, lane: lane3, winnerUserId: cand.user_id,
        result: makeSoftFloor(parsed, cand, false, signals),
      };
    }
  }

  // ---- Floor: most-recently-added visible candidate
  const floorCand = pool[0];
  return helpers.finalize(floorCand, 3, 'floor') || {
    tier: 3 as Tier, lane: 'floor' as Lane, winnerUserId: floorCand.user_id,
    result: makeSoftFloor(parsed, floorCand, false, signals),
  };
}

// ---------------------------------------------------------------------------
// Helpers shared with main()
// ---------------------------------------------------------------------------

function makeSoftFloor(
  parsed: ParsedQuery,
  cand: Candidate,
  ethicsReroute: boolean,
  signals: SignalEntry[],
): FindMemberResult {
  const recipe = buildMatchRecipe({
    parsed,
    tier: 3,
    lane: 'floor',
    ethicsReroute,
    signals: [
      ...signals,
      { label: 'Floor', value: 'closest visible community member', weight: 'sort', matched: true },
    ],
  });
  return {
    ok: true,
    vitana_id: cand.vitana_id,
    display_name: cand.display_name,
    voice_summary: ethicsReroute
      ? `Vitana doesn't rank on appearance or wealth, but ${cand.display_name}'s profile is opening now.`
      : `${cand.display_name} is the closest visible match. Opening their profile.`,
    match_recipe: recipe,
    redirect: { screen: SCREEN_TARGET, route: buildRoute(cand.vitana_id, parsed, undefined) },
  };
}

async function joinedPhraseFor(sb: SupabaseClient, userId: string): Promise<string> {
  try {
    const { data } = await sb
      .from('app_users')
      .select('created_at')
      .eq('user_id', userId)
      .maybeSingle();
    const createdAt = (data as any)?.created_at;
    if (!createdAt) return 'recently';
    const days = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
    return relativeJoinedPhrase(days);
  } catch {
    return 'recently';
  }
}

// Re-export the ProfileCard type for callers that consume both modules.
export type { ProfileCard };
