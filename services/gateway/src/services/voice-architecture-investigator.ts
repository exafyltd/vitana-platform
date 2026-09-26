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
 * Calls the `triage` LLM routing stage (VTID-04626 — see
 * VOICE_INVESTIGATOR_STAGE below) with a strict schema described in the
 * prompt. The schema requires per-hypothesis confidence, top-3 disconfirming
 * data points, and >= 3 alternative architectures with pros/cons/links —
 * designed to make polished hallucination harder — and validateReport() below
 * is the enforcement backstop since the provider can't guarantee the shape.
 * Persists the report to voice_architecture_reports and emits
 * voice.healing.investigation.completed.
 *
 * The recommendation is NEVER auto-executed. Architectural pivots remain
 * a human decision (Command Hub → Voice → Self-Healing).
 *
 * v2 (post-canary): swap for Claude Managed Agents with web_search and
 * web_fetch tools — see Incident Triage Agent in memory.
 *
 * Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md
 */

import { emitOasisEvent } from './oasis-event-service';
import { getVoiceSpecHint } from './voice-spec-hints';
import { notifyGChat } from './self-healing-snapshot-service';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

/**
 * VTID-04626: the investigator runs on the `triage` routing stage through
 * callViaRouter — the DB-backed llm_routing_policy picks the model, a primary
 * outage degrades to the stage's own fallback, and every call is logged to
 * llm.call.* with usage and cost. Until this change it called Bedrock
 * directly with whatever BEDROCK_MODEL_ID the task def carried
 * (`eu.anthropic.claude-opus-4-7`, a profile this account is not subscribed
 * to), so every spawn since at least 2026-09-01 failed with "not available
 * for this account" and wrote an empty v1-stub report.
 */
export const VOICE_INVESTIGATOR_STAGE = 'triage' as const;
export const VOICE_INVESTIGATOR_SERVICE = 'voice-architecture-investigator';
export const VOICE_INVESTIGATOR_MAX_TOKENS = 8192;

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
  | 'quality_failure'
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
// Prompt
// =============================================================================

/**
 * VTID-04626: what the ORB voice pipeline actually runs on today. The prompt
 * used to tell the model the pipeline was "Vertex AI Gemini Live + Cloud
 * TTS" — GCP was decommissioned 2026-08-16 — so every report recommended
 * instrumenting a Gemini Live session that no longer exists.
 */
export const VOICE_PIPELINE_DESCRIPTION =
  'Amazon Nova Sonic (bidirectional speech-to-speech on AWS Bedrock) for en/de/fr/es/it and most sessions; ' +
  'a cascade of Amazon Transcribe (speech-to-text) -> Claude on Bedrock (reply) -> Amazon Polly or Fish Audio (text-to-speech) ' +
  'for languages Nova cannot speak (ru, pl, tr, zh, ar, ...); and a narrow Vertex Gemini Live bridge on a dedicated GCP project ' +
  'for Serbian only. The browser widget streams microphone audio over WebSocket/SSE to the gateway (AWS ECS), which relays it upstream. ' +
  'Full-duplex barge-in is enabled on staging: the mic stays open while the model speaks, with echo gated to digital silence.';

function buildPrompt(input: InvestigatorInput, ev: EvidenceBundle, summary: ReturnType<typeof summarizeEvidence>): string {
  return `You are an Architecture Investigator for the Vitana ORB voice-to-voice pipeline.

Current pipeline: ${VOICE_PIPELINE_DESCRIPTION}

Context: the Recurrence Sentinel, the Spec Memory Gate or the session quality classifier has flagged a failure pattern. Your job is to produce a STRUCTURED REPORT that helps a human operator decide whether to keep patching the existing stack, redesign the pipeline, or replace a vendor. Ground every hypothesis in the evidence below; say so plainly when the evidence is too thin.

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
${ev.deterministic_spec ? ev.deterministic_spec.slice(0, 4000) : '(class has no deterministic spec)'}

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

// VTID-01996: Vertex Gemini structured-output mode rejects JSON-Schema union
// types like `type: ['string', 'null']`. Use `nullable: true` instead, which
// is the OpenAPI 3 / Vertex-supported way to allow null. (Encountered when
// 5 quality-failure investigator spawns produced 0 persisted reports —
// Vertex was silently rejecting the schema.)
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    class: { type: 'string' },
    signature: { type: 'string', nullable: true },
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

interface ClaudeInvestigatorResult {
  report: InvestigatorReport | null;
  error: string | null;
  raw_text?: string;
  provider?: string;
  model?: string;
  fallback_used?: boolean;
}

/** Pull the first balanced JSON object out of a model response, tolerating fences/prose. */
export function extractJsonObject(raw: string): string {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  if (cleaned.startsWith('{')) return cleaned;
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
}

/**
 * VTID-04626: one call on the `triage` routing stage. The schema travels as a
 * textual instruction and validateReport() is the enforcement backstop.
 * Never throws — every failure comes back as `error` with the real reason.
 */
async function callClaudeInvestigator(prompt: string, vtid?: string | null): Promise<ClaudeInvestigatorResult> {
  try {
    const { callViaRouter } = await import('./llm-router');
    const r = await callViaRouter(VOICE_INVESTIGATOR_STAGE, prompt, {
      vtid: vtid || null,
      service: VOICE_INVESTIGATOR_SERVICE,
      systemPrompt:
        'Return ONE JSON object only — no markdown fences, no prose before or after — ' +
        `conforming exactly to this JSON Schema:\n${JSON.stringify(RESPONSE_SCHEMA)}`,
      maxTokens: VOICE_INVESTIGATOR_MAX_TOKENS,
      allowFallback: true,
    });
    const meta = {
      provider: r.provider ? String(r.provider) : undefined,
      model: r.model ? String(r.model) : undefined,
      fallback_used: Boolean(r.fallbackUsed),
    };
    if (!r.ok || !r.text) {
      return { report: null, error: `llm_call_failed: ${r.error || 'empty response'}`, ...meta };
    }
    try {
      return { report: JSON.parse(extractJsonObject(r.text)) as InvestigatorReport, error: null, raw_text: r.text, ...meta };
    } catch (parseErr: any) {
      return {
        report: null,
        error: `llm_json_parse_failed: ${parseErr?.message ?? 'unknown'}`,
        raw_text: r.text.slice(0, 4000),
        ...meta,
      };
    }
  } catch (err: any) {
    const detail = `llm_threw: ${err?.message ?? String(err)}`;
    console.warn(`[voice-architecture-investigator] ${detail}`);
    return { report: null, error: detail };
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

/**
 * VTID-01996: Persist a failure stub when the investigator can't produce a
 * valid report. Without this, investigator failures were silent — 5 spawns
 * resulted in 0 rows and ops had no signal of WHY. The stub stores the
 * error string and the evidence we DID gather so ops can iterate the prompt
 * or model config.
 */
async function persistFailureStub(
  input: InvestigatorInput,
  reason: string,
  detail: string,
  evidenceSummary: ReturnType<typeof summarizeEvidence>,
  llm?: Record<string, unknown>,
): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return null;
  const stubReport = {
    investigator_status: 'failed',
    _llm: llm ?? null,
    failure_reason: reason,
    failure_detail: detail.slice(0, 4000),
    class: input.class,
    signature: input.normalized_signature,
    trigger_reason: input.trigger_reason,
    notes: input.notes,
    evidence_at_failure: evidenceSummary,
    captured_at: new Date().toISOString(),
  };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/voice_architecture_reports`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
      body: JSON.stringify({
        class: input.class,
        normalized_signature: input.normalized_signature,
        trigger_reason: input.trigger_reason,
        schema_version: 'v1-stub',
        report: stubReport,
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

/** VTID-04626: categorical failure reason from the call's error string. */
export function investigatorFailureReason(error: string): string {
  const m = /^(llm_call_failed|llm_json_parse_failed|llm_threw)/.exec(error || '');
  return m ? m[1] : 'llm_no_response';
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

  const prompt = buildPrompt(input, ev, summary);
  const callResult = await callClaudeInvestigator(prompt, input.related_vtid);
  const llm = {
    stage: VOICE_INVESTIGATOR_STAGE,
    provider: callResult.provider ?? null,
    model: callResult.model ?? null,
    fallback_used: callResult.fallback_used ?? false,
  };

  if (!callResult.report) {
    // VTID-01996: persist a failure stub so ops sees WHY the investigator
    // didn't produce a report. VTID-04626: the reason is now the real
    // category (llm_call_failed / llm_json_parse_failed / llm_threw) instead
    // of a blanket 'claude_no_response'.
    const error = callResult.error ?? 'model returned no parseable JSON and no error captured';
    const reason = investigatorFailureReason(error);
    const stubId = await persistFailureStub(input, reason, error, summary, llm);
    return {
      ok: false,
      report_id: stubId,
      validation: { ok: false, reason },
      vertex_responded: false,
      detail: `Investigator produced no usable report: ${error}`,
    };
  }

  const report = callResult.report;
  (report as any)._llm = llm;
  const validation = validateReport(report);
  if (!validation.ok) {
    // Persist anyway — schema-violating reports are still useful for ops to
    // see what the agent produced and iterate the prompt.
    const persistedId = await persistReport(input, report);
    return {
      ok: false,
      report_id: persistedId,
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

  // VTID-02030: ping ops via Gchat for any recommendation that ISN'T
  // stay_and_patch. The auto-loop only handles stay_and_patch autonomously
  // (it flows through Accept & Execute); anything else (patch_around,
  // replace_vendor, redesign_pipeline, "Architectural", "Redesign & Replace",
  // or any unexpected free-text track the LLM returns) needs a supervisor.
  // Inverting the rule means a non-conforming track defaults to "page the
  // human" rather than "stay quiet" — fail-loud is the safer default.
  const STAY_AND_PATCH_TRACKS = new Set(['stay_and_patch']);
  if (!STAY_AND_PATCH_TRACKS.has(report.recommendation.track)) {
    const summary = (report.recommendation.summary || '').slice(0, 280);
    const message =
      `🧠 *Voice — architectural action recommended*\n` +
      `Class: \`${input.class}\`\n` +
      `Track: *${report.recommendation.track}* ` +
      `(confidence ${(report.recommendation.confidence * 100).toFixed(0)}%)\n` +
      `Trigger: ${input.trigger_reason}\n` +
      `${summary}\n` +
      `Report ID: \`${reportId}\` — open Voice Lab → Healing tab to read & Accept & Execute`;
    console.log(
      `[voice-architecture-investigator] gchat-ping prep: track=${report.recommendation.track} ` +
      `webhook_set=${Boolean(process.env.GCHAT_COMMANDHUB_WEBHOOK)}`,
    );
    try {
      await notifyGChat(message);
      console.log(
        `[voice-architecture-investigator] gchat-ping sent for class=${input.class} report=${reportId}`,
      );
    } catch (err: any) {
      console.error(
        `[voice-architecture-investigator] gchat-ping FAILED: ${err?.message ?? err}`,
      );
    }
  }

  return {
    ok: true,
    report_id: reportId,
    validation,
    vertex_responded: true,
  };
}
