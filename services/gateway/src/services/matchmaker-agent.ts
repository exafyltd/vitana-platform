/**
 * VTID-DANCE-D12: Matchmaker agent (Gemini 2.5 Pro).
 *
 * Layer 2 over the SQL matcher. Takes the top-K candidates from
 * compute_intent_matches() + the requester's full context, asks Gemini
 * 2.5 Pro to re-rank and explain, and returns a richer match list.
 *
 * Density-aware:
 *  - solo  (pool < 5)  → simpler prompt, focus on presentation + fallbacks
 *  - early (pool < 50) → moderate re-rank, broader candidate consideration
 *  - growth+           → full reasoning, asymmetric compatibility, etc.
 *
 * Sensitive kinds (`partner_seek`, paid services) get extended thinking on
 * by default. Other kinds use the default reasoning budget.
 *
 * During the credit window (now → 2026-07-01) every model selection
 * favours quality: 2.5 Pro for matchmaker, embeddings via gemini-embedding-001.
 *
 * Falls back gracefully to SQL ranking if Gemini fails.
 */

import { VertexAI } from '@google-cloud/vertexai';
import { getSupabase } from '../lib/supabase';
import { withGeminiLog } from './gemini-call-log';
import type { MatchRow } from './intent-matcher';

const VERTEX_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'lovable-vitana-vers1';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const PRIMARY_MODEL = 'gemini-2.5-pro';
const FALLBACK_MODEL = 'gemini-2.0-flash';

let vertexAI: VertexAI | null = null;
try {
  if (VERTEX_PROJECT && VERTEX_LOCATION) {
    vertexAI = new VertexAI({ project: VERTEX_PROJECT, location: VERTEX_LOCATION });
  }
} catch {
  vertexAI = null;
}

export interface MatchmakerCandidateOut {
  match_id: string | null;            // null when this came purely from profile fallback
  intent_id: string | null;           // null when this is a profile-only candidate
  vitana_id: string | null;
  display_name: string | null;
  sql_score: number | null;
  agent_score: number;                 // 0-1
  reason: string;                      // one-sentence natural-language explanation
  source: 'sql_match' | 'profile_fallback';
  flags: string[];                     // ['low_specificity', 'cross_tenant', 'partner_redacted', etc.]
}

export interface MatchmakerResult {
  ok: boolean;
  mode: 'solo' | 'early' | 'growth';
  pool_size: number;
  candidates: MatchmakerCandidateOut[];
  counter_questions: { id: string; prompt: string; options?: string[] }[];
  voice_readback: string;              // ready-to-speak summary for ORB
  reasoning_summary: string;           // for telemetry/debug
  used_fallback: boolean;              // true when profile-as-supply was used
}

interface SourceIntent {
  intent_id: string;
  intent_kind: string;
  category: string | null;
  title: string;
  scope: string;
  kind_payload: Record<string, any>;
  requester_user_id: string;
  requester_vitana_id: string | null;
  tenant_id: string;
}

interface RequesterContext {
  vitana_id: string | null;
  display_name: string | null;
  city: string | null;
  registration_seq: number | null;
  dance_preferences: Record<string, any> | null;
  life_compass_category: string | null;
  recent_intents: Array<{ intent_kind: string; title: string; created_at: string }>;
  recent_matches_outcomes: Array<{ kind_pairing: string; state: string; counterparty_vitana_id: string | null }>;
}

interface SqlCandidate {
  match_id: string;
  intent_b_id: string | null;
  vitana_id_b: string | null;
  cand_intent: SourceIntent | null;
  cand_profile: { display_name: string | null; city: string | null; dance_preferences: Record<string, any> | null } | null;
  sql_score: number;
}

interface ProfileFallbackCandidate {
  user_id: string;
  vitana_id: string | null;
  display_name: string | null;
  city: string | null;
  dance_preferences: Record<string, any> | null;
}

const SENSITIVE_KINDS = new Set(['partner_seek']);

/** Top-level entry: run the matchmaker over a fresh intent. */
export async function runMatchmakerForIntent(intentId: string): Promise<MatchmakerResult> {
  const ctx = await loadContext(intentId);
  if (!ctx) {
    return defaultEmptyResult('intent_not_found');
  }

  const { source, requester } = ctx;
  const sqlCandidates = await loadSqlCandidates(intentId);
  const poolSize = await probePoolSize(source);
  const mode: MatchmakerResult['mode'] =
    poolSize < 5 ? 'solo' : poolSize < 50 ? 'early' : 'growth';

  // Profile fallback when SQL returns 0 candidates.
  const profileFallback = sqlCandidates.length === 0
    ? await loadProfileFallback(source, requester)
    : [];

  // Build the prompt and invoke Gemini.
  const prompt = buildAgentPrompt({
    source, requester, mode, poolSize,
    sqlCandidates, profileFallback,
  });

  const isSensitive = SENSITIVE_KINDS.has(source.intent_kind);
  const model = isSensitive || mode === 'growth' ? PRIMARY_MODEL : PRIMARY_MODEL; // always Pro during credit window

  const agentResponse = await callAgent({
    prompt, model, source, requester, intentId,
  });

  // If Gemini failed, fall back to a deterministic shape from SQL only.
  if (!agentResponse) {
    return buildSqlOnlyResult({ source, mode, poolSize, sqlCandidates });
  }

  return {
    ok: true,
    mode,
    pool_size: poolSize,
    candidates: agentResponse.candidates,
    counter_questions: agentResponse.counter_questions,
    voice_readback: agentResponse.voice_readback,
    reasoning_summary: agentResponse.reasoning_summary,
    used_fallback: profileFallback.length > 0,
  };
}

// ─── Context loaders ────────────────────────────────────────────

async function loadContext(intentId: string): Promise<{ source: SourceIntent; requester: RequesterContext } | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data: srcRow } = await supabase
    .from('user_intents')
    .select('intent_id, intent_kind, category, title, scope, kind_payload, requester_user_id, requester_vitana_id, tenant_id')
    .eq('intent_id', intentId)
    .maybeSingle();
  if (!srcRow) return null;
  const source = srcRow as any as SourceIntent;

  const { data: profileRow } = await supabase
    .from('profiles')
    .select('vitana_id, display_name, city, registration_seq, dance_preferences')
    .eq('user_id', source.requester_user_id)
    .maybeSingle();

  // Best-effort fetches — silent on error.
  let lifeCompassCategory: string | null = null;
  try {
    const { data } = await supabase
      .from('life_compass_active_view')
      .select('category')
      .eq('user_id', source.requester_user_id)
      .maybeSingle();
    lifeCompassCategory = ((data as any)?.category as string) ?? null;
  } catch { /* table may not exist on every env */ }

  const { data: recentIntents } = await supabase
    .from('user_intents')
    .select('intent_kind, title, created_at')
    .eq('requester_user_id', source.requester_user_id)
    .order('created_at', { ascending: false })
    .limit(10);

  const { data: recentOutcomes } = await supabase
    .from('intent_matches')
    .select('kind_pairing, state, vitana_id_b')
    .eq('vitana_id_a', source.requester_vitana_id ?? '')
    .order('created_at', { ascending: false })
    .limit(20);

  return {
    source,
    requester: {
      vitana_id: (profileRow as any)?.vitana_id ?? null,
      display_name: (profileRow as any)?.display_name ?? null,
      city: (profileRow as any)?.city ?? null,
      registration_seq: (profileRow as any)?.registration_seq ?? null,
      dance_preferences: (profileRow as any)?.dance_preferences ?? null,
      life_compass_category: lifeCompassCategory,
      recent_intents: ((recentIntents as any[]) || []).map((r) => ({
        intent_kind: r.intent_kind,
        title: r.title,
        created_at: r.created_at,
      })),
      recent_matches_outcomes: ((recentOutcomes as any[]) || []).map((m) => ({
        kind_pairing: m.kind_pairing,
        state: m.state,
        counterparty_vitana_id: m.vitana_id_b,
      })),
    },
  };
}

async function loadSqlCandidates(intentId: string): Promise<SqlCandidate[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data: matches } = await supabase
    .from('intent_matches')
    .select('match_id, intent_a_id, intent_b_id, vitana_id_a, vitana_id_b, score, kind_pairing, state')
    .eq('intent_a_id', intentId)
    .order('score', { ascending: false })
    .limit(20);
  if (!matches || matches.length === 0) return [];

  const intentBIds = (matches as any[]).map((m) => m.intent_b_id).filter(Boolean) as string[];
  const userIds: string[] = [];

  let intentMap: Record<string, SourceIntent> = {};
  let profileMap: Record<string, any> = {};

  if (intentBIds.length > 0) {
    const { data: intents } = await supabase
      .from('user_intents')
      .select('intent_id, intent_kind, category, title, scope, kind_payload, requester_user_id, requester_vitana_id, tenant_id')
      .in('intent_id', intentBIds);
    intentMap = Object.fromEntries(((intents as any[]) || []).map((r) => [r.intent_id, r]));
    for (const r of (intents as any[]) || []) {
      if (r.requester_user_id) userIds.push(r.requester_user_id);
    }
  }

  if (userIds.length > 0) {
    const { data: profs } = await supabase
      .from('profiles')
      .select('user_id, display_name, city, dance_preferences')
      .in('user_id', userIds);
    profileMap = Object.fromEntries(((profs as any[]) || []).map((r) => [r.user_id, r]));
  }

  return (matches as any[]).map((m) => {
    const ci = m.intent_b_id ? intentMap[m.intent_b_id] : null;
    const cp = ci?.requester_user_id ? profileMap[ci.requester_user_id] : null;
    return {
      match_id: m.match_id,
      intent_b_id: m.intent_b_id,
      vitana_id_b: m.vitana_id_b,
      cand_intent: ci ?? null,
      cand_profile: cp
        ? { display_name: cp.display_name, city: cp.city, dance_preferences: cp.dance_preferences }
        : null,
      sql_score: m.score,
    };
  });
}

async function probePoolSize(source: SourceIntent): Promise<number> {
  const supabase = getSupabase();
  if (!supabase) return 0;
  const { count } = await supabase
    .from('user_intents')
    .select('intent_id', { count: 'exact', head: true })
    .neq('requester_user_id', source.requester_user_id)
    .in('status', ['open', 'matched', 'engaged']);
  return count ?? 0;
}

async function loadProfileFallback(
  source: SourceIntent, _requester: RequesterContext
): Promise<ProfileFallbackCandidate[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const variety: string | null =
    (source.kind_payload as any)?.dance?.variety
    ?? (source.category && source.category.startsWith('dance.') ? source.category.split('.').pop() ?? null : null);

  // Pull profiles that have ANY dance preferences set, prioritising same variety.
  const { data: profs } = await supabase
    .from('profiles')
    .select('user_id, vitana_id, display_name, city, dance_preferences')
    .neq('user_id', source.requester_user_id)
    .not('dance_preferences', 'eq', '{}')
    .limit(20);
  const list = ((profs as any[]) || []).filter((p) => {
    const v = p.dance_preferences?.varieties;
    return Array.isArray(v) && v.length > 0;
  });

  // Bias same-variety to top.
  list.sort((a, b) => {
    const avHas = variety && Array.isArray(a.dance_preferences?.varieties) && a.dance_preferences.varieties.includes(variety) ? 1 : 0;
    const bvHas = variety && Array.isArray(b.dance_preferences?.varieties) && b.dance_preferences.varieties.includes(variety) ? 1 : 0;
    return bvHas - avHas;
  });

  return list.slice(0, 5).map((p) => ({
    user_id: p.user_id,
    vitana_id: p.vitana_id,
    display_name: p.display_name,
    city: p.city,
    dance_preferences: p.dance_preferences,
  }));
}

// ─── Prompt builder + agent call ────────────────────────────────

function buildAgentPrompt(args: {
  source: SourceIntent;
  requester: RequesterContext;
  mode: MatchmakerResult['mode'];
  poolSize: number;
  sqlCandidates: SqlCandidate[];
  profileFallback: ProfileFallbackCandidate[];
}): string {
  const { source, requester, mode, poolSize, sqlCandidates, profileFallback } = args;

  return [
    'You are Vitana\'s matchmaking agent. Your job is to take the candidates produced by the SQL matcher (and a possible profile fallback) and produce a high-quality, honest, voice-friendly response. Always respect the user\'s actual situation — never fake density.',
    '',
    `Density mode: ${mode} (pool size: ${poolSize}). Adjust strictness accordingly:`,
    '  - solo:   pool is tiny. Surface ALL candidates, even with low SQL scores. Be honest that the community is small. Suggest sharing the post with friends.',
    '  - early:  some candidates exist. Re-rank with reasoning. If specificity is low, broaden across category prefix.',
    '  - growth: full pool. Re-rank tightly, favour reciprocal compatibility.',
    '',
    'CONTEXT — Source intent (the person asking):',
    JSON.stringify({
      kind: source.intent_kind,
      category: source.category,
      title: source.title,
      scope: source.scope,
      kind_payload: source.kind_payload,
    }, null, 2),
    '',
    'CONTEXT — Requester profile + history:',
    JSON.stringify({
      vitana_id: requester.vitana_id,
      display_name: requester.display_name,
      city: requester.city,
      registration_seq: requester.registration_seq,
      dance_preferences: requester.dance_preferences,
      life_compass_focus: requester.life_compass_category,
      recent_intents: requester.recent_intents.slice(0, 5),
      recent_match_outcomes: requester.recent_matches_outcomes.slice(0, 10),
    }, null, 2),
    '',
    `CANDIDATES from SQL matcher (top ${sqlCandidates.length}):`,
    JSON.stringify(sqlCandidates.map((c) => ({
      match_id: c.match_id,
      sql_score: c.sql_score,
      counterparty_vitana_id: c.vitana_id_b,
      counterparty_intent_kind: c.cand_intent?.intent_kind,
      counterparty_category: c.cand_intent?.category,
      counterparty_title: c.cand_intent?.title,
      counterparty_scope: c.cand_intent?.scope?.slice(0, 280),
      counterparty_kind_payload: c.cand_intent?.kind_payload,
      counterparty_profile_city: c.cand_profile?.city,
      counterparty_profile_dance_preferences: c.cand_profile?.dance_preferences,
    })), null, 2),
    '',
    `PROFILE FALLBACK candidates (${profileFallback.length}; use only when SQL is empty or weak):`,
    JSON.stringify(profileFallback.map((p) => ({
      vitana_id: p.vitana_id,
      display_name: p.display_name,
      city: p.city,
      dance_preferences: p.dance_preferences,
    })), null, 2),
    '',
    'TASK:',
    '1. Re-rank up to 5 best candidates. Each candidate gets:',
    '   - agent_score (0-1) — your considered confidence',
    '   - reason (one short sentence) — natural-language WHY this fits',
    '   - flags (array) — e.g. ["low_specificity"] when both sides are vague, ["cross_tenant"], ["partner_redacted"]',
    '   - source — "sql_match" or "profile_fallback"',
    '2. If the source intent is sparse (no variety, no time, no location), produce 1–2 counter_questions in this exact shape:',
    '   { "id": "variety", "prompt": "What style — salsa, tango, bachata, or open to anything?", "options": ["salsa","tango","bachata","kizomba","swing","open"] }',
    '   { "id": "time", "prompt": "When — specific evening or any time?", "options": ["any","weekday-eve","weekend","specific"] }',
    '   { "id": "location", "prompt": "Where — your city or somewhere else?" }',
    '   Skip questions whose answer is already in the source kind_payload.',
    '3. Produce a voice_readback string ORB will read aloud. Be honest about pool size:',
    '   - mode=solo with 0 candidates: "I posted your ask — you\'re among the first looking for this in our community. The moment someone matches I\'ll let you know. Want me to share with friends?"',
    '   - mode=solo with 1+ candidates: "You\'re early — I found N other people interested in something similar. Here are the closest signals: ..."',
    '   - mode=early/growth: tighter, reasoned readback per candidate.',
    '   Keep total readback under 60 words.',
    '4. Produce a reasoning_summary (one paragraph) explaining your overall thinking — for telemetry, not for the user.',
    '',
    'OUTPUT — return ONLY valid JSON in this exact schema. No markdown, no prose:',
    '{ "candidates": [ { "match_id": "...", "intent_id": "...", "vitana_id": "...", "display_name": "...", "sql_score": 0.0, "agent_score": 0.0, "reason": "...", "source": "sql_match", "flags": [...] } ], "counter_questions": [ ... ], "voice_readback": "...", "reasoning_summary": "..." }',
  ].join('\n');
}

interface AgentRawOutput {
  candidates?: Array<Partial<MatchmakerCandidateOut>>;
  counter_questions?: Array<{ id: string; prompt: string; options?: string[] }>;
  voice_readback?: string;
  reasoning_summary?: string;
}

async function callAgent(args: {
  prompt: string; model: string; source: SourceIntent; requester: RequesterContext; intentId: string;
}): Promise<{
  candidates: MatchmakerCandidateOut[];
  counter_questions: { id: string; prompt: string; options?: string[] }[];
  voice_readback: string;
  reasoning_summary: string;
} | null> {
  if (!vertexAI) return null;
  const { prompt, model, source, requester, intentId } = args;

  try {
    const result = await withGeminiLog(
      {
        feature: 'matchmaker',
        model,
        user_id: source.requester_user_id ?? null,
        vitana_id: requester.vitana_id,
        intent_id: intentId,
      },
      async () => {
        const genModel = vertexAI!.getGenerativeModel({
          model,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 4096,
            topP: 0.9,
            responseMimeType: 'application/json',
          },
        });
        const resp = await genModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });
        const part = resp.response?.candidates?.[0]?.content?.parts?.find((p: any) => 'text' in p);
        const raw = part ? (part as any).text : '';
        return raw;
      }
    );

    if (!result) return null;
    const parsed: AgentRawOutput = JSON.parse(result);
    const candidates: MatchmakerCandidateOut[] = (parsed.candidates || [])
      .map((c): MatchmakerCandidateOut => ({
        match_id: c.match_id ?? null,
        intent_id: c.intent_id ?? null,
        vitana_id: c.vitana_id ?? null,
        display_name: c.display_name ?? null,
        sql_score: typeof c.sql_score === 'number' ? c.sql_score : null,
        agent_score: typeof c.agent_score === 'number' ? Math.max(0, Math.min(1, c.agent_score)) : 0.5,
        reason: c.reason ?? '',
        source: (c.source as any) === 'profile_fallback' ? 'profile_fallback' : 'sql_match',
        flags: Array.isArray(c.flags) ? c.flags : [],
      }))
      .slice(0, 5);

    return {
      candidates,
      counter_questions: parsed.counter_questions || [],
      voice_readback: parsed.voice_readback || '',
      reasoning_summary: parsed.reasoning_summary || '',
    };
  } catch (err: any) {
    console.warn(`[VTID-DANCE-D12] matchmaker agent (${model}) failed: ${err.message}`);
    return null;
  }
}

// ─── SQL-only fallback when Gemini fails ────────────────────────

function buildSqlOnlyResult(args: {
  source: SourceIntent;
  mode: MatchmakerResult['mode'];
  poolSize: number;
  sqlCandidates: SqlCandidate[];
}): MatchmakerResult {
  const { mode, poolSize, sqlCandidates } = args;
  const candidates = sqlCandidates.slice(0, 5).map((c): MatchmakerCandidateOut => ({
    match_id: c.match_id,
    intent_id: c.intent_b_id,
    vitana_id: c.vitana_id_b,
    display_name: c.cand_profile?.display_name ?? null,
    sql_score: c.sql_score,
    agent_score: c.sql_score,
    reason: c.cand_intent?.title ?? 'Possible match',
    source: 'sql_match',
    flags: ['agent_unavailable'],
  }));

  const readback = candidates.length === 0
    ? "I posted your ask — you're early in the community. I'll let you know the moment someone matches."
    : `I found ${candidates.length} possible match${candidates.length === 1 ? '' : 'es'}. Take a look.`;

  return {
    ok: true,
    mode,
    pool_size: poolSize,
    candidates,
    counter_questions: [],
    voice_readback: readback,
    reasoning_summary: 'Gemini matchmaker unavailable; returned SQL-ranked candidates without re-ranking.',
    used_fallback: false,
  };
}

function defaultEmptyResult(_reason: string): MatchmakerResult {
  return {
    ok: false,
    mode: 'solo',
    pool_size: 0,
    candidates: [],
    counter_questions: [],
    voice_readback: "I couldn't read your post — try again?",
    reasoning_summary: 'intent_not_found',
    used_fallback: false,
  };
}

// Re-export for the route layer.
export type { MatchRow };
