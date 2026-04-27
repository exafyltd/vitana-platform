/**
 * Self-Healing Triage Service
 *
 * Reusable synchronous wrapper around Claude Managed Agents that the
 * self-healing pipeline calls at three points:
 *
 *   1. PRE-FIX:  low-confidence deterministic diagnosis → agent investigates
 *                deeper → may upgrade confidence or enrich human context
 *   2. POST-FAILURE: reconciler exhausted redispatches → agent analyzes the
 *                full failure history → produces a revised diagnosis for a
 *                fresh self-healing cycle
 *   3. VERIFICATION_FAILURE: blast radius detected → agent reads pre/post
 *                snapshots + applied diff → explains what went wrong
 *
 * The agent has access to:
 *   - The vitana-platform repo (mounted at /workspace/repo)
 *   - OASIS events via the `query_oasis_events` custom tool (Supabase creds host-side)
 *   - E2E test results via the `query_test_results` custom tool (future)
 *
 * Shared Anthropic API helpers and config are imported from triage-agent.ts.
 */

const LOG_PREFIX = '[self-healing-triage]';

// Config from environment (same as triage-agent.ts)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AGENT_ID = process.env.TRIAGE_AGENT_ID || 'agent_011Ca1RTRZADaWdZsKAKjs3B';
const ENVIRONMENT_ID = process.env.TRIAGE_ENVIRONMENT_ID || 'env_01VrvRRUWP91wiFQrmWaUcEh';
const ANTHROPIC_BASE = 'https://api.anthropic.com';
const BETA_HEADER = 'managed-agents-2026-04-01';
const MAX_TRIAGE_ATTEMPTS = 2;
const SESSION_TIMEOUT_MS = 120_000; // 2 minutes max per triage session

// =============================================================================
// Types
// =============================================================================

export type TriageMode = 'pre_fix' | 'post_failure' | 'verification_failure';

export interface TriageInput {
  mode: TriageMode;
  vtid: string;
  // Pre-fix mode
  diagnosis?: Record<string, unknown>;
  failure?: { endpoint: string; name?: string; status?: string; error?: string };
  // Post-failure mode
  original_diagnosis?: Record<string, unknown>;
  failure_class?: string;
  endpoint?: string;
  all_attempts?: number;
  reconciler_history?: Record<string, unknown>;
  // Verification failure mode
  applied_spec?: string;
  verification_result?: Record<string, unknown>;
  pre_fix_snapshot?: unknown;
  post_fix_snapshot?: unknown;
  blast_radius?: unknown;
}

export interface TriageReport {
  session_id: string;
  severity: 'critical' | 'warning' | 'info';
  root_cause_hypothesis: string;
  affected_component: string;
  evidence: string[];
  recommended_fix: string;
  confidence: 'high' | 'medium' | 'low';
  confidence_numeric: number;
  elapsed_ms: number;
  mode: TriageMode;
  raw_output: string;
}

export interface TriageResult {
  ok: boolean;
  report?: TriageReport;
  error?: string;
}

// =============================================================================
// Anthropic API helper (duplicated from triage-agent.ts to avoid circular dep)
// =============================================================================

async function anthropicRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<{ ok: boolean; data?: T; error?: string }> {
  if (!ANTHROPIC_API_KEY) {
    return { ok: false, error: 'ANTHROPIC_API_KEY not set' };
  }

  try {
    const response = await fetch(`${ANTHROPIC_BASE}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': BETA_HEADER,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}` };
    }

    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// OASIS events custom tool handler (same as triage-agent.ts)
// =============================================================================

async function queryOasisEvents(
  sessionId: string,
  limit: number = 100
): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return 'Error: Missing Supabase credentials';
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/oasis_events?or=(metadata->>session_id.eq.${encodeURIComponent(sessionId)},metadata->>sessionId.eq.${encodeURIComponent(sessionId)})&order=created_at.asc&limit=${limit}&select=id,topic,vtid,status,message,metadata,created_at`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!response.ok) {
      return `Error: Supabase ${response.status}: ${await response.text()}`;
    }

    const events = await response.json();
    return JSON.stringify(events, null, 2);
  } catch (error) {
    return `Error: ${String(error)}`;
  }
}

// =============================================================================
// Prompt builders per mode
// =============================================================================

function buildPrompt(input: TriageInput): string {
  const lines: string[] = [];

  switch (input.mode) {
    case 'pre_fix':
      lines.push(
        `## Investigation Mode: PRE-FIX DEEP TRIAGE`,
        ``,
        `The deterministic self-healing classifier produced a diagnosis with`,
        `insufficient confidence. Your job is to investigate deeper using`,
        `source code and OASIS events, and either upgrade the confidence`,
        `or provide richer context for human approval.`,
        ``,
        `### VTID: ${input.vtid}`,
        `### Endpoint: ${input.failure?.endpoint || 'unknown'}`,
        `### Service: ${input.failure?.name || 'unknown'}`,
        `### Deterministic Diagnosis:`,
        `${JSON.stringify(input.diagnosis, null, 2)}`,
        ``,
        `### Instructions`,
        `1. Call query_oasis_events if the diagnosis mentions a session_id`,
        `2. Read the relevant source code in /workspace/repo/ based on the failure class`,
        `3. Produce your triage report with a confidence assessment`,
      );
      break;

    case 'post_failure':
      lines.push(
        `## Investigation Mode: POST-FAILURE FEEDBACK LOOP`,
        ``,
        `A previous self-healing attempt for this endpoint FAILED. The`,
        `reconciler exhausted its redispatch budget and the endpoint is`,
        `still down. Your job is to analyze the FULL failure history,`,
        `understand WHY the previous fix didn't work, and propose a`,
        `DIFFERENT approach.`,
        ``,
        `### VTID: ${input.vtid}`,
        `### Endpoint: ${input.endpoint || 'unknown'}`,
        `### Failure Class: ${input.failure_class || 'unknown'}`,
        `### Previous Attempts: ${input.all_attempts || 0}`,
        `### Reconciler History:`,
        `${JSON.stringify(input.reconciler_history, null, 2)}`,
        `### Original Diagnosis:`,
        `${JSON.stringify(input.original_diagnosis, null, 2)}`,
        ``,
        `### Instructions`,
        `1. Read the source code that was targeted by the previous fix`,
        `2. Understand why the previous approach failed`,
        `3. Propose a DIFFERENT root cause and fix — do not repeat the same approach`,
        `4. Your diagnosis will feed a FRESH self-healing cycle with a new VTID`,
      );
      break;

    case 'verification_failure':
      lines.push(
        `## Investigation Mode: VERIFICATION FAILURE ANALYSIS`,
        ``,
        `A self-healing fix was applied but verification detected problems`,
        `— either blast radius (newly broken endpoints) or the original`,
        `endpoint is still down. The fix will be rolled back. Your job is`,
        `to analyze what went wrong so the next attempt is better-informed.`,
        ``,
        `### VTID: ${input.vtid}`,
        `### Applied Spec:`,
        `${input.applied_spec || '(not available)'}`,
        `### Verification Result:`,
        `${JSON.stringify(input.verification_result, null, 2)}`,
        `### Blast Radius:`,
        `${JSON.stringify(input.blast_radius, null, 2)}`,
        ``,
        `### Instructions`,
        `1. Read the code that was modified by the applied spec`,
        `2. Analyze why the fix caused blast radius or failed verification`,
        `3. Explain what went wrong and what the next attempt should do differently`,
      );
      break;
  }

  lines.push(
    ``,
    `## Output Format`,
    `End your investigation with a structured report:`,
    ``,
    `### Triage Report`,
    `- **Session ID**: (your managed session id)`,
    `- **Severity**: critical / warning / info`,
    `- **Root Cause Hypothesis**: 1-2 sentences`,
    `- **Affected Component**: file path + function name`,
    `- **Evidence**: bullet list`,
    `- **Recommended Fix**: concrete next step`,
    `- **Confidence**: high / medium / low`,
  );

  return lines.join('\n');
}

// =============================================================================
// Report parser — extracts structured data from the agent's text output
// =============================================================================

function parseTriageReport(
  rawText: string,
  sessionId: string,
  mode: TriageMode,
  elapsedMs: number
): TriageReport {
  const extract = (label: string): string => {
    const regex = new RegExp(`\\*\\*${label}\\*\\*:\\s*(.+?)(?=\\n\\*\\*|\\n###|$)`, 's');
    const match = rawText.match(regex);
    return match ? match[1].trim() : '';
  };

  const severityRaw = extract('Severity').toLowerCase();
  const severity = (['critical', 'warning', 'info'].includes(severityRaw)
    ? severityRaw
    : 'warning') as 'critical' | 'warning' | 'info';

  const confidenceRaw = extract('Confidence').toLowerCase();
  const confidence = (['high', 'medium', 'low'].includes(confidenceRaw)
    ? confidenceRaw
    : 'low') as 'high' | 'medium' | 'low';

  const confidenceNumeric =
    confidence === 'high' ? 0.85 : confidence === 'medium' ? 0.65 : 0.4;

  const evidenceRaw = extract('Evidence');
  const evidence = evidenceRaw
    .split('\n')
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line.length > 0);

  return {
    session_id: sessionId,
    severity,
    root_cause_hypothesis: extract('Root Cause Hypothesis'),
    affected_component: extract('Affected Component'),
    evidence,
    recommended_fix: extract('Recommended Fix'),
    confidence,
    confidence_numeric: confidenceNumeric,
    elapsed_ms: elapsedMs,
    mode,
    raw_output: rawText,
  };
}

// =============================================================================
// Main entry point: spawnTriageAgent
// =============================================================================

/**
 * BOOTSTRAP-LLM-ROUTER (Phase C): triage now goes through the provider
 * router. The router reads llm_routing_policy.policy.triage and dispatches
 * to the configured provider (Vertex / Anthropic / OpenAI / DeepSeek).
 *
 * Architectural change vs the prior Managed Agents flow: instead of giving
 * the model a `query_oasis_events` tool that fires mid-session, we
 * pre-fetch the OASIS events for the failure session up front and attach
 * them to the prompt. This is lossless for the diagnosis path (the agent
 * always called the tool with the same session_id from `input.diagnosis`)
 * and works across every provider — no Managed Agents dependency.
 *
 * The repo-mount feature is dropped — for the diagnosis use case the model
 * doesn't need to read code on demand; failure context + recent events is
 * sufficient. If a stage genuinely needs repo browsing in future, that's a
 * separate router extension.
 */
export async function spawnTriageAgent(input: TriageInput): Promise<TriageResult> {
  const startTime = Date.now();
  console.log(`${LOG_PREFIX} Triage for ${input.vtid} (mode=${input.mode})`);

  // 1. Pre-fetch OASIS events keyed off any session_id mentioned in the
  //    diagnosis. The original Managed Agents path did this lazily via a
  //    custom tool; we just pull them upfront and inline.
  const sessionIdHint = (input.diagnosis as Record<string, unknown> | undefined)?.session_id
    || (input.diagnosis as Record<string, unknown> | undefined)?.sessionId
    || '';
  let oasisEventsBlock = '';
  if (typeof sessionIdHint === 'string' && sessionIdHint) {
    try {
      const eventsJson = await queryOasisEvents(sessionIdHint, 50);
      oasisEventsBlock = `\n### OASIS events for session ${sessionIdHint} (most recent 50):\n${eventsJson}\n`;
    } catch (err) {
      console.warn(`${LOG_PREFIX} OASIS prefetch failed:`, err);
    }
  }

  // 2. Build the prompt — same per-mode template as before, plus the
  //    pre-fetched events if any.
  const prompt = buildPrompt(input) + oasisEventsBlock;

  // 3. Single-shot call via router. Provider chosen by llm_routing_policy.
  //    `pseudoSessionId` is just a correlation id for the parser — there is
  //    no real session.
  const pseudoSessionId = `triage-${input.vtid}-${Date.now()}`;
  const r = await (async () => {
    const { callViaRouter } = await import('./llm-router');
    return callViaRouter('triage', prompt, {
      vtid: input.vtid,
      service: 'self-healing-triage',
      systemPrompt: 'You are a self-healing triage agent. Investigate the failure and produce a structured report with: Severity, Root Cause Hypothesis, Affected Component, Evidence (bulleted list), Recommended Fix, Confidence (low|medium|high). Use plain markdown headings (## Severity, ## Root Cause Hypothesis, etc.).',
      maxTokens: 4000,
      allowFallback: true,
    });
  })();

  const elapsedMs = Date.now() - startTime;

  if (!r.ok) {
    console.warn(`${LOG_PREFIX} Triage router call failed for ${input.vtid}: ${r.error}`);
    return { ok: false, error: r.error || 'router returned ok=false' };
  }

  const rawOutput = r.text || '';
  if (!rawOutput) {
    console.warn(`${LOG_PREFIX} Triage produced no text for ${input.vtid}`);
    return { ok: false, error: 'Triage produced no output' };
  }

  const report = parseTriageReport(rawOutput, pseudoSessionId, input.mode, elapsedMs);
  console.log(
    `${LOG_PREFIX} Triage complete for ${input.vtid}: provider=${r.provider} model=${r.model} confidence=${report.confidence} (${report.confidence_numeric}) elapsed=${elapsedMs}ms`
  );

  return { ok: true, report };
}

// =============================================================================
// Helper: create a fresh VTID from a triage report for the feedback loop
// =============================================================================

export async function createFreshVtidFromTriageReport(
  parentVtid: string,
  report: TriageReport,
  endpoint: string,
): Promise<string | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  // Generate a new VTID by incrementing the latest
  try {
    const latestRes = await fetch(
      `${supabaseUrl}/rest/v1/vtid_ledger?select=vtid&order=created_at.desc&limit=1`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!latestRes.ok) return null;
    const latest = (await latestRes.json()) as Array<{ vtid: string }>;
    const lastNum = latest.length > 0
      ? parseInt(latest[0].vtid.replace('VTID-', ''), 10)
      : 1900;
    const newVtid = `VTID-${String(lastNum + 1).padStart(5, '0')}`;

    // Insert the new VTID into the ledger
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        vtid: newVtid,
        title: `SELF-HEAL (retry): ${report.root_cause_hypothesis.substring(0, 80)}`,
        summary: report.recommended_fix,
        status: 'in_progress',
        layer: 'OPS',
        module: 'SELF-HEAL',
        metadata: {
          source: 'self-healing-triage-loop',
          parent_vtid: parentVtid,
          triage_session_id: report.session_id,
          triage_confidence: report.confidence,
          triage_mode: report.mode,
          endpoint,
        },
      }),
    });

    if (!insertRes.ok) {
      console.error(`${LOG_PREFIX} Failed to create VTID: ${insertRes.status}`);
      return null;
    }

    console.log(`${LOG_PREFIX} Created fresh VTID ${newVtid} (parent: ${parentVtid})`);
    return newVtid;
  } catch (error) {
    console.error(`${LOG_PREFIX} createFreshVtid error:`, error);
    return null;
  }
}

export { MAX_TRIAGE_ATTEMPTS };
