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

import { VertexAI } from '@google-cloud/vertexai';
import type { SupabaseClient } from '@supabase/supabase-js';

export const SIGNAL_PROFILE_NARRATIVE = 'user_profile_narrative_v1';
/** Below this many live facts a narrative adds nothing — skip. */
export const MIN_FACTS_FOR_NARRATIVE = 3;
const MAX_FACTS_IN_PROMPT = 30;
const MAX_ROUTINES_IN_PROMPT = 5;
const NARRATIVE_MODEL = 'gemini-2.0-flash';

const VERTEX_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'lovable-vitana-vers1';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';

let vertexAI: VertexAI | null = null;
try {
  vertexAI = new VertexAI({ project: VERTEX_PROJECT, location: VERTEX_LOCATION });
} catch (err: any) {
  console.warn(`[user-model-synthesis] Vertex init failed: ${err?.message}`);
}

const SYNTHESIS_SYSTEM_PROMPT = `You write a compact profile of a wellness-community member for their AI companion's private context. INPUTS are structured records the system has verified. Your job is to SYNTHESIZE, not to list:

- Connect related records into one picture (a goal + a routine + a weak health pillar that plausibly relate — say how).
- 4 to 8 sentences of plain English prose. No headings, no bullets, no markdown.
- STRICT GROUNDING: only restate or connect what the inputs say. NEVER invent details, diagnoses, or causes the inputs don't support. Use hedged language ("seems to", "may be related") for connections.
- Prioritize: health-relevant patterns first, then people who matter to them, then preferences/routines, then open threads (upcoming events, concerns).
- Write about "the user" in third person. This text is never shown to the user directly.`;

export interface SynthesisInputs {
  facts: Array<{ fact_key: string; fact_value: string; provenance_source: string }>;
  routines: Array<{ title: string; summary: string }>;
  goal: string | null;
  index: { total: number | null; weakest_pillar: string | null } | null;
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
    supabase
      .from('memory_facts')
      .select('fact_key, fact_value, provenance_source')
      .eq('tenant_id', tenantId)
      .eq('user_id', userId)
      .is('superseded_at', null)
      .order('provenance_confidence', { ascending: false })
      .order('extracted_at', { ascending: false })
      .limit(MAX_FACTS_IN_PROMPT),
    supabase
      .from('user_routines')
      .select('title, summary')
      .eq('user_id', userId)
      .order('confidence', { ascending: false })
      .limit(MAX_ROUTINES_IN_PROMPT),
    supabase
      .from('life_compass')
      .select('primary_goal')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('vitana_index_scores')
      .select('score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental')
      .eq('user_id', userId)
      .order('date', { ascending: false })
      .limit(1),
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

  return {
    facts: (factsRes.data || []) as SynthesisInputs['facts'],
    routines: (routinesRes.data || []) as SynthesisInputs['routines'],
    goal: ((goalRes.data || [])[0] as { primary_goal?: string } | undefined)?.primary_goal ?? null,
    index,
  };
}

async function callSynthesisModel(inputs: SynthesisInputs): Promise<string | null> {
  if (!vertexAI) return null;
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

  try {
    const model = vertexAI.getGenerativeModel({
      model: NARRATIVE_MODEL,
      generationConfig: { temperature: 0.3, maxOutputTokens: 400, topP: 0.9 },
      systemInstruction: { role: 'system', parts: [{ text: SYNTHESIS_SYSTEM_PROMPT }] },
    });
    const response = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: lines.join('\n') }] }],
    });
    const text = response.response?.candidates?.[0]?.content?.parts?.[0]?.text;
    const narrative = typeof text === 'string' ? text.trim() : '';
    return narrative.length >= 40 ? narrative : null;
  } catch (err: any) {
    console.warn(`[user-model-synthesis] model call failed: ${err?.message}`);
    return null;
  }
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
  if (inputs.facts.length < MIN_FACTS_FOR_NARRATIVE) {
    return { ok: true, written: false, reason: 'too_few_facts' };
  }
  const hash = computeInputsHash(inputs);

  const { data: existing } = await supabase
    .from('user_assistant_state')
    .select('value')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('signal_name', SIGNAL_PROFILE_NARRATIVE)
    .maybeSingle();
  const prior = (existing as { value?: { inputs_hash?: string } } | null)?.value;
  if (prior?.inputs_hash === hash) {
    return { ok: true, written: false, reason: 'inputs_unchanged' };
  }

  const narrative = await callSynthesisModel(inputs);
  if (!narrative) return { ok: false, written: false, reason: 'model_failed' };

  const nowIso = new Date().toISOString();
  const { error } = await supabase.from('user_assistant_state').upsert(
    {
      tenant_id: tenantId,
      user_id: userId,
      signal_name: SIGNAL_PROFILE_NARRATIVE,
      value: {
        narrative,
        generated_at: nowIso,
        inputs_hash: hash,
        facts_count: inputs.facts.length,
      },
      last_seen_at: nowIso,
    },
    { onConflict: 'tenant_id,user_id,signal_name' },
  );
  if (error) return { ok: false, written: false, reason: error.message };
  return { ok: true, written: true };
}

/** Read the stored narrative (null when absent/stale-schema/error). */
export async function readUserProfileNarrative(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
): Promise<{ narrative: string; generated_at: string } | null> {
  try {
    const { data, error } = await supabase
      .from('user_assistant_state')
      .select('value')
      .eq('tenant_id', tenantId)
      .eq('user_id', userId)
      .eq('signal_name', SIGNAL_PROFILE_NARRATIVE)
      .maybeSingle();
    if (error || !data) return null;
    const v = (data as { value?: { narrative?: unknown; generated_at?: unknown } }).value;
    if (v && typeof v.narrative === 'string' && v.narrative.trim()) {
      return {
        narrative: v.narrative,
        generated_at: typeof v.generated_at === 'string' ? v.generated_at : '',
      };
    }
    return null;
  } catch {
    return null;
  }
}
