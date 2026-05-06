/**
 * Architecture Investigator (BOOTSTRAP-ARCH-INV)
 *
 * System-wide root-cause hypothesis generator. Generalizes the voice-scoped
 * voice-architecture-investigator (VTID-01963) into a stage-agnostic agent.
 *
 * Flow:
 *   1. Caller passes an incident (topic + optional vtid/signature/notes)
 *   2. We pull recent oasis_events for context
 *   3. We call deepseek-reasoner with a structured-output prompt
 *   4. We persist the report to architecture_reports
 *   5. We emit architecture.investigation.completed
 *
 * Hypotheses are NEVER auto-executed — they are advisory inputs to
 * self-healing and human review.
 */

import { emitOasisEvent } from './oasis-event-service';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.ARCH_INVESTIGATOR_MODEL || 'deepseek-reasoner';

const LOG_PREFIX = '[architecture-investigator]';

// =============================================================================
// Types
// =============================================================================

export type InvestigatorTrigger =
  | 'manual'
  | 'self_healing'
  | 'sentinel'
  | 'spec_memory_blocked'
  | 'quality_failure';

export interface InvestigatorInput {
  incident_topic: string;
  vtid?: string;
  signature?: string;
  trigger_reason?: InvestigatorTrigger;
  notes?: string;
  /** Limit on oasis_events to pull. Default 50. */
  event_limit?: number;
}

export interface InvestigatorReport {
  id: string;
  root_cause: string;
  confidence: number;
  suggested_fix: string;
  alternative_hypotheses: Array<{
    hypothesis: string;
    confidence: number;
    why_less_likely: string;
  }>;
  evidence_summary: {
    event_count: number;
    distinct_topics: string[];
    time_window_minutes: number;
  };
  llm_provider: 'deepseek';
  llm_model: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  latency_ms: number;
}

// =============================================================================
// Supabase helper (PostgREST via service role)
// =============================================================================

async function supabaseRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<{ ok: boolean; data?: T; error?: string }> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }
  try {
    const resp = await fetch(`${SUPABASE_URL}${path}`, {
      method: options.method || 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await resp.text();
    const data = text ? JSON.parse(text) : null;
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, data: data as T };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Request failed' };
  }
}

// =============================================================================
// Evidence gathering
// =============================================================================

interface OasisEventRow {
  id: string;
  topic: string;
  vtid: string | null;
  service: string | null;
  status: string | null;
  message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

async function gatherEvents(input: InvestigatorInput): Promise<OasisEventRow[]> {
  const limit = input.event_limit ?? 50;
  let path = `/rest/v1/oasis_events?select=id,topic,vtid,service,status,message,metadata,created_at&order=created_at.desc&limit=${limit}`;

  // Filter by vtid if provided, otherwise filter by topic prefix
  if (input.vtid) {
    path += `&vtid=eq.${encodeURIComponent(input.vtid)}`;
  } else if (input.incident_topic) {
    // Pull events with the incident topic OR any errors in the same window
    path += `&or=(topic.eq.${encodeURIComponent(input.incident_topic)},status.eq.error)`;
  }

  const result = await supabaseRequest<OasisEventRow[]>(path);
  if (!result.ok || !result.data) {
    console.warn(`${LOG_PREFIX} Event fetch failed: ${result.error}`);
    return [];
  }
  return result.data;
}

function summarizeEvents(events: OasisEventRow[]): InvestigatorReport['evidence_summary'] {
  if (events.length === 0) {
    return { event_count: 0, distinct_topics: [], time_window_minutes: 0 };
  }
  const topics = new Set<string>();
  for (const e of events) topics.add(e.topic);
  const oldest = new Date(events[events.length - 1].created_at).getTime();
  const newest = new Date(events[0].created_at).getTime();
  return {
    event_count: events.length,
    distinct_topics: Array.from(topics),
    time_window_minutes: Math.round((newest - oldest) / 60000),
  };
}

// =============================================================================
// LLM call (DeepSeek-reasoner)
// =============================================================================

const SYSTEM_PROMPT = `You are an architecture investigator for the Vitana platform. You analyze incident telemetry and produce ONE structured root-cause hypothesis with a concrete suggested fix and at least 2 alternative hypotheses with reasons they are less likely.

Output MUST be valid JSON matching this schema:
{
  "root_cause": "string (concrete technical statement, not generic)",
  "confidence": 0.0-1.0,
  "suggested_fix": "string (specific code/config/ops change)",
  "alternative_hypotheses": [
    {"hypothesis": "string", "confidence": 0.0-1.0, "why_less_likely": "string"},
    ...
  ]
}

Rules:
- Cite specific events, codes, or paths from the evidence — do not speculate
- Confidence must reflect actual signal in the evidence
- "why_less_likely" must reference disconfirming evidence
- If evidence is insufficient for a confident hypothesis, set confidence < 0.5 and say so plainly`;

interface DeepSeekResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

async function callDeepSeek(prompt: string): Promise<{
  text: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  latency_ms: number;
}> {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY not set');
  }
  const start = Date.now();
  const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      max_tokens: 4096,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });
  const latency_ms = Date.now() - start;
  if (!resp.ok) {
    const body = await resp.text().catch(() => '<no body>');
    throw new Error(`DeepSeek HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = (await resp.json()) as DeepSeekResponse;
  const text = data.choices?.[0]?.message?.content || '';
  return {
    text,
    prompt_tokens: data.usage?.prompt_tokens,
    completion_tokens: data.usage?.completion_tokens,
    latency_ms,
  };
}

function buildPrompt(input: InvestigatorInput, events: OasisEventRow[]): string {
  const lines: string[] = [];
  lines.push(`# Incident Investigation`);
  lines.push(`Topic: ${input.incident_topic}`);
  if (input.vtid) lines.push(`VTID: ${input.vtid}`);
  if (input.signature) lines.push(`Signature: ${input.signature}`);
  if (input.trigger_reason) lines.push(`Trigger: ${input.trigger_reason}`);
  if (input.notes) lines.push(`Operator notes: ${input.notes}`);
  lines.push('');
  lines.push(`# Recent OASIS events (most recent first, ${events.length} rows)`);
  for (const e of events.slice(0, 30)) {
    const meta = e.metadata ? JSON.stringify(e.metadata).slice(0, 200) : '';
    lines.push(
      `- ${e.created_at} [${e.topic}] status=${e.status || '-'} vtid=${e.vtid || '-'} service=${e.service || '-'} msg=${(e.message || '').slice(0, 120)} meta=${meta}`
    );
  }
  lines.push('');
  lines.push(`Produce the structured JSON hypothesis now.`);
  return lines.join('\n');
}

function parseReport(text: string): {
  root_cause: string;
  confidence: number;
  suggested_fix: string;
  alternative_hypotheses: InvestigatorReport['alternative_hypotheses'];
} {
  // Extract first {...} block
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Model output had no JSON block');
  const parsed = JSON.parse(m[0]);
  if (typeof parsed.root_cause !== 'string' || typeof parsed.suggested_fix !== 'string') {
    throw new Error('Model output missing required fields');
  }
  const confidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0;
  const alternatives = Array.isArray(parsed.alternative_hypotheses)
    ? parsed.alternative_hypotheses.slice(0, 5)
    : [];
  return {
    root_cause: parsed.root_cause,
    confidence,
    suggested_fix: parsed.suggested_fix,
    alternative_hypotheses: alternatives,
  };
}

// =============================================================================
// Persistence
// =============================================================================

async function persistReport(
  input: InvestigatorInput,
  parsed: ReturnType<typeof parseReport>,
  evidence: InvestigatorReport['evidence_summary'],
  llm: { prompt_tokens?: number; completion_tokens?: number; latency_ms: number }
): Promise<string | null> {
  const row = {
    incident_topic: input.incident_topic,
    vtid: input.vtid || null,
    signature: input.signature || null,
    trigger_reason: input.trigger_reason || 'manual',
    root_cause: parsed.root_cause,
    confidence: parsed.confidence,
    suggested_fix: parsed.suggested_fix,
    alternative_hypotheses: parsed.alternative_hypotheses,
    llm_provider: 'deepseek',
    llm_model: DEEPSEEK_MODEL,
    evidence_summary: evidence,
    prompt_tokens: llm.prompt_tokens || null,
    completion_tokens: llm.completion_tokens || null,
    latency_ms: llm.latency_ms,
    status: 'open',
  };
  const result = await supabaseRequest<Array<{ id: string }>>('/rest/v1/architecture_reports', {
    method: 'POST',
    body: row,
  });
  if (!result.ok || !result.data || result.data.length === 0) {
    console.error(`${LOG_PREFIX} Persist failed: ${result.error}`);
    return null;
  }
  return result.data[0].id;
}

// =============================================================================
// Public entry point
// =============================================================================

export async function investigateIncident(
  input: InvestigatorInput
): Promise<InvestigatorReport> {
  console.log(`${LOG_PREFIX} Investigating incident: topic=${input.incident_topic} vtid=${input.vtid || '-'}`);

  const events = await gatherEvents(input);
  const evidence = summarizeEvents(events);
  const prompt = buildPrompt(input, events);

  const llm = await callDeepSeek(prompt);
  const parsed = parseReport(llm.text);

  const id = await persistReport(input, parsed, evidence, llm);

  // Emit OASIS event so downstream watchers (self-healing) can pick it up
  await emitOasisEvent({
    type: 'architecture.investigation.completed',
    source: 'architecture-investigator',
    vtid: input.vtid || 'BOOTSTRAP-ARCH-INV',
    status: 'info',
    message: `Hypothesis (confidence=${parsed.confidence.toFixed(2)}): ${parsed.root_cause.slice(0, 200)}`,
    payload: {
      report_id: id,
      incident_topic: input.incident_topic,
      signature: input.signature,
      trigger_reason: input.trigger_reason || 'manual',
      confidence: parsed.confidence,
      provider: 'deepseek',
      model: DEEPSEEK_MODEL,
      latency_ms: llm.latency_ms,
    },
  }).catch((err) => {
    console.warn(`${LOG_PREFIX} OASIS emit failed: ${err?.message}`);
  });

  return {
    id: id || '',
    root_cause: parsed.root_cause,
    confidence: parsed.confidence,
    suggested_fix: parsed.suggested_fix,
    alternative_hypotheses: parsed.alternative_hypotheses,
    evidence_summary: evidence,
    llm_provider: 'deepseek',
    llm_model: DEEPSEEK_MODEL,
    prompt_tokens: llm.prompt_tokens,
    completion_tokens: llm.completion_tokens,
    latency_ms: llm.latency_ms,
  };
}
