/**
 * Architecture Investigator (VTID-01963, PR #6)
 *
 * Spawned when:
 *   - Recurrence Sentinel quarantines a (class, signature) — PR #5.
 *   - Spec Memory Gate blocks a dispatch — PR #3.
 *
 * Reads:
 *   - voice_healing_history rows for the class
 *   - voice_healing_spec_memory rows for the signature
 *   - Recent oasis_events for the session/class
 *   - Deterministic spec body if available (voice-spec-hints)
 *
 * Calls Vertex Gemini with a strict structured-output schema. The schema
 * requires per-hypothesis confidence, top-3 disconfirming data points,
 * and ≥ 3 alternative architectures with pros/cons/links — designed to
 * make polished hallucination harder. Persists the report to
 * voice_architecture_reports and emits voice.healing.investigation.completed.
 *
 * The recommendation is NEVER auto-executed. Architectural pivots remain
 * a human decision (review in Healing dashboard, PR #8).
 *
 * v2 (post-canary): swap the Vertex call for Claude Managed Agents with
 * web_search and web_fetch tools — see Incident Triage Agent in memory.
 *
 * Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md
 */

import { VertexAI } from '@google-cloud/vertexai';
import { GoogleAuth } from 'google-auth-library';
import { emitOasisEvent } from './oasis-event-service';
import { getVoiceSpecHint } from './voice-spec-hints';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const VERTEX_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  'lovable-vitana-vers1';
const INVESTIGATOR_MODEL = process.env.VOICE_INVESTIGATOR_MODEL || 'gemini-2.5-pro';

// =============================================================================
// Vertex client (lazy init — same pattern as self-healing-spec-service)
// =============================================================================

let vertexAI: VertexAI | null = null;
let googleAuth: GoogleAuth | null = null;
try {
  googleAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  vertexAI = new VertexAI({ project: VERTEX_PROJECT, location: 'us-central1' });
} catch (err: any) {
  console.warn(`[voice-architecture-investigator] Vertex init failed: ${err.message}`);
}

// =============================================================================
// Pre-vetted alternative architectures (v1 — agent picks the relevant subset
// per failure class). v2 will replace this with web_search results.
// =============================================================================

const ALTERNATIVE_ARCHITECTURES_REFERENCE = `
- LiveKit Agents (https://docs.livekit.io/agents/) — open-source orchestration; STT/TTS provider-agnostic; mature WebRTC stack; cloud or self-host.
- OpenAI Realtime API (https://platform.openai.com/docs/guides/realtime) — gpt-4o-realtime; closed source; lowest-latency voice today; OpenAI lock-in.
- Pipecat (https://github.com/pipecat-ai/pipecat) — open-source Python framework; modular; community-maintained; requires assembly.
- Deepgram Voice Agent (https://deepgram.com/voice-agent) — STT-first stack; low latency on transcription; pairs with own TTS or third-party.
- Cartesia Sonic (https://cartesia.ai/sonic) — low-latency expressive TTS; pair with separate ASR + LLM.
- ElevenLabs Conversational AI (https://elevenlabs.io/conversational-ai) — premium TTS voices; integrated agent; higher cost.
- Vapi.ai (https://vapi.ai) — managed voice agent platform; phone-first; LLM-agnostic.
- Retell AI (https://www.retellai.com) — managed voice agent; phone calls; LLM and voice provider routing.
`.trim();

// =============================================================================
// Types
// =============================================================================

export type InvestigatorTriggerReason =
  | 'sentinel_quarantine'
  | 'spec_memory_blocked'
  | 'manual';

export interface InvestigatorInput {
  class: string;
  normalized_signature: string | null;
  trigger_reason: InvestigatorTriggerReason;
  related_spec_hash?: string | null;
  related_vtid?: string | null;
  notes?: string;
}

export interface InvestigatorReport {
  class: string;
  signature: string | null;
  evidence: {
    dispatch_count: number;
    rollback_count: number;
    suppressed_count: number;
    time_window_hours: number;
    top_signatures: Array<{ signature_id: string; count: number }>;
    spec_memory_failures: Array<{
      spec_hash: string;
      signature: string;
      attempts: number;
      outcome: string;
    }>;
  };
  internal_findings: {
    code_paths_involved: Array<{ file: string; lines: string; role: string }>;
    third_party_integration_health: Record<string, unknown>;
    notable_anti_patterns: string[];
    hypotheses: Array<{
      hypothesis: string;
      confidence: number;
      supporting_evidence: string[];
      disconfirming_evidence: string[];
      top_3_disconfirming_data_points: string[];
    }>;
  };
  external_findings: {
    similar_incidents_in_industry: string[];
    notable_post_mortems: string[];
  };
  alternatives: Array<{
    name: string;
    vendor_or_oss: 'vendor' | 'oss';
    latency_profile: string;
    cost_profile: string;
    maturity: string;
    integration_effort: string;
    blocking_concerns: string[];
    pros: string[];
    cons: string[];
    links: string[];
  }>;
  recommendation: {
    track: 'stay_and_patch' | 'patch_around' | 'replace_vendor' | 'redesign_pipeline';
    summary: string;
    rationale: string;
    confidence: number;
    contradiction_check: string;
    proposed_next_steps: string[];
    required_human_decisions: string[];
  };
}

// =============================================================================
// Evidence gathering
// =============================================================================

function supabaseHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
  };
}

interface EvidenceBundle {
  history: any[];
  spec_memory: any[];
  recent_oasis: any[];
  deterministic_spec: string | null;
}

async function gatherEvidence(input: InvestigatorInput): Promise<EvidenceBundle> {
  const empty: EvidenceBundle = {
    history: [],
    spec_memory: [],
    recent_oasis: [],
    deterministic_spec: null,
  };
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return empty;

  const since30d = new Date(Date.now() - 30 * 86400_000).toISOString();
  const klass = input.class;
  const sig = input.normalized_signature;

  const sigFilter = sig ? `&normalized_signature=eq.${encodeURIComponent(sig)}` : '';

  try {
    const [historyRes, specRes, oasisRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/voice_healing_history?` +
          `class=eq.${encodeURIComponent(klass)}${sigFilter}&` +
          `dispatched_at=gte.${encodeURIComponent(since30d)}&` +
          `order=dispatched_at.desc&limit=200`,
        { headers: supabaseHeaders() },
      ),
      sig
        ? fetch(
            `${SUPABASE_URL}/rest/v1/voice_healing_spec_memory?` +
              `normalized_signature=eq.${encodeURIComponent(sig)}&` +
              `attempted_at=gte.${encodeURIComponent(since30d)}&` +
              `order=attempted_at.desc&limit=100`,
            { headers: supabaseHeaders() },
          )
        : Promise.resolve(new Response('[]', { status: 200 })),
      fetch(
        `${SUPABASE_URL}/rest/v1/oasis_events?` +
          `topic=like.orb.live.*&` +
          `created_at=gte.${encodeURIComponent(since30d)}&` +
          `order=created_at.desc&limit=50`,
        { headers: supabaseHeaders() },
      ),
    ]);

    const history = historyRes.ok ? ((await historyRes.json()) as any[]) : [];
    const spec_memory = specRes.ok ? ((await specRes.json()) as any[]) : [];
    const recent_oasis = oasisRes.ok ? ((await oasisRes.json()) as any[]) : [];

    const hint = getVoiceSpecHint(klass);
    const deterministic_spec = hint?.spec ?? null;

    return { history, spec_memory, recent_oasis, deterministic_spec };
  } catch {
    return empty;
  }
}

// =============================================================================
// Evidence summarization for the prompt
// =============================================================================

function summarizeEvidence(input: InvestigatorInput, ev: EvidenceBundle): {
  dispatch_count: number;
  rollback_count: number;
  suppressed_count: number;
  top_signatures: Array<{ signature_id: string; count: number }>;
  spec_memory_failures: Array<{
    spec_hash: string;
    signature: string;
    attempts: number;
    outcome: string;
  }>;
} {
  const dispatch_count = ev.history.length;
  const rollback_count = ev.history.filter((r) => r.verdict === 'rollback').length;
  const suppressed_count = ev.history.filter((r) => r.verdict === 'suppressed').length;

  const sigCounts = new Map<string, number>();
  for (const r of ev.history) {
    const sig = String(r.normalized_signature || 'unknown');
    sigCounts.set(sig, (sigCounts.get(sig) || 0) + 1);
  }
  const top_signatures = Array.from(sigCounts.entries())
    .map(([signature_id, count]) => ({ signature_id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const memMap = new Map<string, { spec_hash: string; signature: string; attempts: number; outcomes: string[] }>();
  for (const m of ev.spec_memory) {
    const key = `${m.spec_hash}|${m.normalized_signature}`;
    if (!memMap.has(key)) {
      memMap.set(key, {
        spec_hash: String(m.spec_hash || ''),
        signature: String(m.normalized_signature || ''),
        attempts: 0,
        outcomes: [],
      });
    }
    const entry = memMap.get(key)!;
    entry.attempts++;
    entry.outcomes.push(String(m.outcome || ''));
  }
  const spec_memory_failures = Array.from(memMap.values())
    .filter((m) => m.outcomes.some((o) => o === 'probe_failed' || o === 'rollback'))
    .map((m) => ({
      spec_hash: m.spec_hash,
      signature: m.signature,
      attempts: m.attempts,
      outcome: m.outcomes[0],
    }))
    .slice(0, 10);

  return {
    dispatch_count,
    rollback_count,
    suppressed_count,
    top_signatures,
    spec_memory_failures,
  };
}

// =============================================================================
// Vertex prompt
// =============================================================================

function buildPrompt(input: InvestigatorInput, ev: EvidenceBundle, summary: ReturnType<typeof summarizeEvidence>): string {
  return `You are an Architecture Investigator for the Vitana ORB voice-to-voice pipeline (Vertex AI Gemini Live + Cloud TTS).

Context: the Recurrence Sentinel or the Spec Memory Gate has flagged a persistent failure pattern. Your job is to produce a STRUCTURED REPORT that helps a human operator decide whether to keep patching the existing stack, redesign the pipeline, or replace the vendor (Vertex Live).

The report is NEVER auto-executed. Polish without substance is worse than honesty about uncertainty.

=== INPUT ===
class: ${input.class}
signature: ${input.normalized_signature ?? '(none)'}
trigger_reason: ${input.trigger_reason}
related_spec_hash: ${input.related_spec_hash ?? '(none)'}
related_vtid: ${input.related_vtid ?? '(none)'}
notes: ${input.notes ?? '(none)'}

=== EVIDENCE (last 30 days) ===
dispatch_count: ${summary.dispatch_count}
rollback_count: ${summary.rollback_count}
suppressed_count: ${summary.suppressed_count}
top_signatures: ${JSON.stringify(summary.top_signatures)}
spec_memory_failures: ${JSON.stringify(summary.spec_memory_failures)}

=== RECENT VOICE OASIS EVENTS (most recent ${ev.recent_oasis.length}) ===
${ev.recent_oasis
  .slice(0, 30)
  .map((e: any) => `  - ${e.created_at} [${e.status}] ${e.topic}: ${(e.message || '').slice(0, 200)}`)
  .join('\n')}

=== DETERMINISTIC SPEC (if any) ===
${ev.deterministic_spec ? ev.deterministic_spec.slice(0, 4000) : '(class has no deterministic spec — Gemini fallback)'}

=== ALTERNATIVE ARCHITECTURES REFERENCE (v1 pre-vetted; pick relevant subset) ===
${ALTERNATIVE_ARCHITECTURES_REFERENCE}

=== TASK ===
Produce ONE JSON object that conforms to the response_schema. Hard requirements:
- internal_findings.hypotheses: at least 1, each with confidence in [0, 1] and AT LEAST 3 entries in top_3_disconfirming_data_points (data points that would CHANGE your mind, not just weak evidence).
- alternatives: at least 3 entries from the reference list above (or your own additions). Each MUST have non-empty pros[], cons[], and links[].
- recommendation.contradiction_check: one sentence describing the single piece of evidence that would most strongly invalidate your recommended track.
- recommendation.confidence in [0, 1]. Below 0.5 means "not confident — escalate to manual investigation."

Return JSON only.`;
}

// =============================================================================
// Vertex call with structured output
// =============================================================================

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    class: { type: 'string' },
    signature: { type: ['string', 'null'] },
    evidence: {
      type: 'object',
      properties: {
        dispatch_count: { type: 'integer' },
        rollback_count: { type: 'integer' },
        suppressed_count: { type: 'integer' },
        time_window_hours: { type: 'integer' },
        top_signatures: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              signature_id: { type: 'string' },
              count: { type: 'integer' },
            },
            required: ['signature_id', 'count'],
          },
        },
        spec_memory_failures: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              spec_hash: { type: 'string' },
              signature: { type: 'string' },
              attempts: { type: 'integer' },
              outcome: { type: 'string' },
            },
            required: ['spec_hash', 'signature', 'attempts', 'outcome'],
          },
        },
      },
      required: [
        'dispatch_count',
        'rollback_count',
        'suppressed_count',
        'time_window_hours',
        'top_signatures',
        'spec_memory_failures',
      ],
    },
    internal_findings: {
      type: 'object',
      properties: {
        code_paths_involved: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              lines: { type: 'string' },
              role: { type: 'string' },
            },
            required: ['file', 'lines', 'role'],
          },
        },
        third_party_integration_health: { type: 'object' },
        notable_anti_patterns: { type: 'array', items: { type: 'string' } },
        hypotheses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              hypothesis: { type: 'string' },
              confidence: { type: 'number' },
              supporting_evidence: { type: 'array', items: { type: 'string' } },
              disconfirming_evidence: { type: 'array', items: { type: 'string' } },
              top_3_disconfirming_data_points: { type: 'array', items: { type: 'string' } },
            },
            required: [
              'hypothesis',
              'confidence',
              'supporting_evidence',
              'disconfirming_evidence',
              'top_3_disconfirming_data_points',
            ],
          },
        },
      },
      required: [
        'code_paths_involved',
        'third_party_integration_health',
        'notable_anti_patterns',
        'hypotheses',
      ],
    },
    external_findings: {
      type: 'object',
      properties: {
        similar_incidents_in_industry: { type: 'array', items: { type: 'string' } },
        notable_post_mortems: { type: 'array', items: { type: 'string' } },
      },
      required: ['similar_incidents_in_industry', 'notable_post_mortems'],
    },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          vendor_or_oss: { type: 'string' },
          latency_profile: { type: 'string' },
          cost_profile: { type: 'string' },
          maturity: { type: 'string' },
          integration_effort: { type: 'string' },
          blocking_concerns: { type: 'array', items: { type: 'string' } },
          pros: { type: 'array', items: { type: 'string' } },
          cons: { type: 'array', items: { type: 'string' } },
          links: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'name',
          'vendor_or_oss',
          'latency_profile',
          'cost_profile',
          'maturity',
          'integration_effort',
          'blocking_concerns',
          'pros',
          'cons',
          'links',
        ],
      },
    },
    recommendation: {
      type: 'object',
      properties: {
        track: { type: 'string' },
        summary: { type: 'string' },
        rationale: { type: 'string' },
        confidence: { type: 'number' },
        contradiction_check: { type: 'string' },
        proposed_next_steps: { type: 'array', items: { type: 'string' } },
        required_human_decisions: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'track',
        'summary',
        'rationale',
        'confidence',
        'contradiction_check',
        'proposed_next_steps',
        'required_human_decisions',
      ],
    },
  },
  required: [
    'class',
    'evidence',
    'internal_findings',
    'external_findings',
    'alternatives',
    'recommendation',
  ],
};

async function callVertexInvestigator(prompt: string): Promise<InvestigatorReport | null> {
  if (!vertexAI) return null;
  try {
    const model = vertexAI.getGenerativeModel({
      model: INVESTIGATOR_MODEL,
      generationConfig: {
        temperature: 0.4,
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA as any,
      },
    });
    const r = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const text = r.response?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text) as InvestigatorReport;
  } catch (err: any) {
    console.warn(`[voice-architecture-investigator] Vertex call failed: ${err.message}`);
    return null;
  }
}

// =============================================================================
// Schema validation
// =============================================================================

function validateReport(r: any): { ok: boolean; reason?: string } {
  if (!r || typeof r !== 'object') return { ok: false, reason: 'not_object' };
  if (!r.class || typeof r.class !== 'string') return { ok: false, reason: 'class_missing' };
  if (!r.recommendation?.track) return { ok: false, reason: 'recommendation_track_missing' };
  if (!Array.isArray(r.alternatives) || r.alternatives.length < 3) {
    return { ok: false, reason: 'alternatives_under_3' };
  }
  if (!Array.isArray(r.internal_findings?.hypotheses) || r.internal_findings.hypotheses.length < 1) {
    return { ok: false, reason: 'no_hypotheses' };
  }
  for (const h of r.internal_findings.hypotheses) {
    if (typeof h.confidence !== 'number') {
      return { ok: false, reason: 'hypothesis_confidence_missing' };
    }
    if (!Array.isArray(h.top_3_disconfirming_data_points) || h.top_3_disconfirming_data_points.length < 3) {
      return { ok: false, reason: 'top_3_disconfirming_under_3' };
    }
  }
  if (typeof r.recommendation.confidence !== 'number') {
    return { ok: false, reason: 'recommendation_confidence_missing' };
  }
  if (!r.recommendation.contradiction_check) {
    return { ok: false, reason: 'contradiction_check_missing' };
  }
  return { ok: true };
}

// =============================================================================
// Persistence
// =============================================================================

async function persistReport(input: InvestigatorInput, report: InvestigatorReport): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/voice_architecture_reports`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
      body: JSON.stringify({
        class: input.class,
        normalized_signature: input.normalized_signature,
        trigger_reason: input.trigger_reason,
        schema_version: 'v1',
        report,
        related_quarantine_class: input.class,
        related_quarantine_signature: input.normalized_signature,
        related_spec_hash: input.related_spec_hash ?? null,
        related_vtid: input.related_vtid ?? null,
      }),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

// =============================================================================
// Public entry point
// =============================================================================

export interface InvestigatorResult {
  ok: boolean;
  report_id: string | null;
  validation: { ok: boolean; reason?: string };
  vertex_responded: boolean;
  detail?: string;
}

/**
 * Run the investigator end-to-end. Never throws — returns a structured
 * result. Failures surface as ok=false with a detail field.
 */
export async function spawnInvestigator(input: InvestigatorInput): Promise<InvestigatorResult> {
  const ev = await gatherEvidence(input);
  const summary = summarizeEvidence(input, ev);

  if (!vertexAI) {
    return {
      ok: false,
      report_id: null,
      validation: { ok: false, reason: 'vertex_unavailable' },
      vertex_responded: false,
      detail: 'Vertex client not initialized; investigator skipped.',
    };
  }

  const prompt = buildPrompt(input, ev, summary);
  const report = await callVertexInvestigator(prompt);

  if (!report) {
    return {
      ok: false,
      report_id: null,
      validation: { ok: false, reason: 'vertex_no_response' },
      vertex_responded: false,
      detail: 'Vertex returned no parseable JSON.',
    };
  }

  const validation = validateReport(report);
  if (!validation.ok) {
    // Persist anyway — schema-violating reports are still useful for ops to
    // see what the agent produced and iterate the prompt.
    await persistReport(input, report);
    return {
      ok: false,
      report_id: null,
      validation,
      vertex_responded: true,
      detail: `Schema validation failed: ${validation.reason}`,
    };
  }

  const reportId = await persistReport(input, report);

  try {
    await emitOasisEvent({
      vtid: input.related_vtid ?? 'VTID-VOICE-HEALING',
      type: 'voice.healing.investigation.completed',
      source: 'voice-architecture-investigator',
      status: 'warning',
      message: `Architecture Investigator produced report for ${input.class} (${input.trigger_reason}, recommendation=${report.recommendation.track}, confidence=${report.recommendation.confidence.toFixed(2)})`,
      payload: {
        report_id: reportId,
        class: input.class,
        normalized_signature: input.normalized_signature,
        trigger_reason: input.trigger_reason,
        recommendation_track: report.recommendation.track,
        recommendation_confidence: report.recommendation.confidence,
        alternatives_count: report.alternatives.length,
        hypotheses_count: report.internal_findings.hypotheses.length,
      },
    });
  } catch {
    /* best-effort emit */
  }

  return {
    ok: true,
    report_id: reportId,
    validation,
    vertex_responded: true,
  };
}
