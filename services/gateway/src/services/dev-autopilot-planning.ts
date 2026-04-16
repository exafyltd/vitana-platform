/**
 * Developer Autopilot — Stage B Planning (Managed Agents)
 *
 * Given a finding (autopilot_recommendations row), spawns a Claude Managed
 * Agents session with the vitana-platform repo mounted and asks it to
 * produce a complete plan_markdown in the canonical structure that
 * Claude Code plan mode emits (Context / Target flow / Components / Files
 * / Reused primitives / Implementation order / Verification / Out of scope).
 *
 * Two invocation points:
 *   - Eager: called from synthesis after Stage A ingest for the top K findings
 *     by impact×risk_class (so the queue always has actionable cards)
 *   - Lazy:  called on demand when the user clicks "Expand plan" or approves
 *     a row that has no plan yet
 *
 * Plan versions are append-only: v1 on first generation; v2+ each time the
 * user submits "Continue planning" feedback. Prior versions stay readable.
 *
 * Agent ID resolution (env-driven, falls back to triage agent so we can ship
 * before dedicated Managed Agent provisioning):
 *   DEV_AUTOPILOT_PLANNING_AGENT_ID   → falls back to TRIAGE_AGENT_ID
 *   DEV_AUTOPILOT_PLANNING_ENV_ID     → falls back to TRIAGE_ENVIRONMENT_ID
 *
 * If ANTHROPIC_API_KEY is missing the service returns a deterministic stub
 * plan so the UI / pipeline can be exercised end-to-end in dev.
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { renderPlanHtml } from './dev-autopilot-html';

const LOG_PREFIX = '[dev-autopilot-planning]';
const PLAN_VTID = 'VTID-DEV-AUTOPILOT';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_BASE = 'https://api.anthropic.com';
const BETA_HEADER = 'managed-agents-2026-04-01';
const SESSION_TIMEOUT_MS = 180_000; // 3 minutes per planning session

function getAgentIds(): { agent_id: string; environment_id: string } {
  return {
    agent_id: process.env.DEV_AUTOPILOT_PLANNING_AGENT_ID
           || process.env.TRIAGE_AGENT_ID
           || 'agent_011Ca1RTRZADaWdZsKAKjs3B',
    environment_id: process.env.DEV_AUTOPILOT_PLANNING_ENV_ID
                 || process.env.TRIAGE_ENVIRONMENT_ID
                 || 'env_01VrvRRUWP91wiFQrmWaUcEh',
  };
}

// =============================================================================
// Types
// =============================================================================

export interface FindingForPlanning {
  id: string;
  title: string;
  summary: string;
  domain: string;
  risk_class: 'low' | 'medium' | 'high';
  spec_snapshot: {
    signal_type?: string;
    file_path?: string;
    line_number?: number;
    suggested_action?: string;
    scanner?: string;
  };
}

export interface PlanVersion {
  finding_id: string;
  version: number;
  plan_markdown: string;
  plan_html: string;
  planning_session_id?: string;
  feedback_note?: string;
  files_referenced: string[];
}

export interface PlanningResult {
  ok: boolean;
  plan?: PlanVersion;
  error?: string;
}

// =============================================================================
// Anthropic + Supabase helpers
// =============================================================================

async function anthropicRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(`${ANTHROPIC_BASE}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': BETA_HEADER,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) return { ok: false, error: `${res.status}: ${await res.text()}` };
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

interface SupaConfig { url: string; key: string; }
function getSupabase(): SupaConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return { url, key };
}

async function supaRequest<T>(
  supa: SupaConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; data?: T; status: number; error?: string }> {
  try {
    const res = await fetch(`${supa.url}${path}`, {
      ...init,
      headers: {
        apikey: supa.key,
        Authorization: `Bearer ${supa.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(init.headers || {}),
      },
    });
    if (!res.ok) return { ok: false, status: res.status, error: `${res.status}: ${await res.text()}` };
    if (res.status === 204) return { ok: true, status: 204 };
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 500, error: String(err) };
  }
}

// =============================================================================
// Prompt builder
// =============================================================================

function buildPlanningPrompt(
  finding: FindingForPlanning,
  previousPlan?: string,
  feedbackNote?: string,
): string {
  const snap = finding.spec_snapshot || {};
  const lines: string[] = [];

  lines.push(
    `# Developer Autopilot — Plan Generation`,
    ``,
    `You are generating a plan that a developer will approve with one click.`,
    `A single click triggers end-to-end execution (branch → edits → PR → CI →`,
    `merge → deploy). Depth and precision matter.`,
    ``,
    `## Finding`,
    `- **Title:** ${finding.title}`,
    `- **Summary:** ${finding.summary}`,
    `- **Domain:** ${finding.domain}`,
    `- **Risk class:** ${finding.risk_class}`,
    `- **Signal type:** ${snap.signal_type || 'unknown'}`,
    `- **File:** ${snap.file_path || '(unspecified)'}${snap.line_number ? `:${snap.line_number}` : ''}`,
    `- **Scanner:** ${snap.scanner || '(unknown)'}`,
    `- **Suggested action:** ${snap.suggested_action || '(none)'}`,
    ``,
  );

  if (previousPlan && feedbackNote) {
    lines.push(
      `## Previous plan (v-1) — reviewer feedback below`,
      ``,
      `\`\`\`markdown`,
      previousPlan.substring(0, 4000),
      `\`\`\``,
      ``,
      `## Reviewer feedback`,
      feedbackNote,
      ``,
      `Revise the plan to address the feedback above. Keep what was good, change`,
      `what the reviewer flagged, and output a complete new plan — not a diff.`,
      ``,
    );
  }

  lines.push(
    `## Your task`,
    `1. Open /workspace/repo and read the file(s) referenced by the finding.`,
    `2. Verify the signal — is it genuine, what is the root cause, what else is`,
    `   affected?`,
    `3. Identify any tests, types, or callers that a fix must touch.`,
    `4. Write a complete plan using the canonical structure below. Cite every`,
    `   file you propose to modify by its repo-relative path. A plan that cites`,
    `   a file that doesn't exist will be rejected by validation.`,
    ``,
    `## Output format — raw markdown, no code fences around the whole document`,
    ``,
    `## Context`,
    `(Why this change — the problem, what prompted it, the intended outcome.)`,
    ``,
    `## Target flow`,
    `(Short narrative or ASCII diagram of the end-to-end behavior after the change.)`,
    ``,
    `## Components to build / modify`,
    `(One bullet per file, grouped by purpose. Include file path + what changes.)`,
    ``,
    `## Files to modify`,
    `(Flat list of repo-relative paths, one per line, exactly as they exist in`,
    ` /workspace/repo. Include test files.)`,
    ``,
    `## Reused primitives`,
    `(Existing functions/types/services the change should call into — do not`,
    ` rebuild anything already in the repo.)`,
    ``,
    `## Implementation order`,
    `(Numbered steps a developer or agent can follow.)`,
    ``,
    `## Verification`,
    `(Unit tests + integration path + observable outcome.)`,
    ``,
    `## Out of scope`,
    `(Things intentionally not in this change.)`,
  );

  return lines.join('\n');
}

// =============================================================================
// File-path extraction + validation (catches hallucinated paths)
// =============================================================================

const PATH_LINE_RE = /(?<![a-zA-Z0-9])((?:services|supabase|scripts|\.github|specs|src)\/[a-zA-Z0-9_./\-]+\.(?:ts|tsx|js|jsx|sql|yml|yaml|json|md))/g;

export function extractFilePaths(markdown: string): string[] {
  const paths = new Set<string>();
  const filesSection = markdown.match(/##\s*Files to modify[\s\S]+?(?=\n##\s|$)/i);
  if (filesSection) {
    for (const line of filesSection[0].split('\n').slice(1)) {
      const match = line.match(/([a-zA-Z0-9_./\-]+\.(?:ts|tsx|js|jsx|sql|yml|yaml|json|md))/);
      if (match && match[1].includes('/')) paths.add(match[1]);
    }
  }
  // Fallback: scan the whole plan for paths
  for (const m of markdown.matchAll(PATH_LINE_RE)) {
    paths.add(m[1]);
  }
  return Array.from(paths);
}

// =============================================================================
// Stub plan generator (used when ANTHROPIC_API_KEY is missing)
// =============================================================================

function buildStubPlan(finding: FindingForPlanning, note?: string): string {
  const snap = finding.spec_snapshot || {};
  const file = snap.file_path || 'services/gateway/src/services/example.ts';
  const base = file.split('/').pop() || 'example.ts';
  const testFile = file.replace(/\.ts$/, '.test.ts').replace('src/', 'test/');
  const lines = [
    `## Context`,
    `${finding.summary} Deterministic plan generated without LLM (ANTHROPIC_API_KEY unset in this environment).${note ? ' Reviewer feedback: ' + note : ''}`,
    ``,
    `## Target flow`,
    `Apply the suggested action: ${snap.suggested_action || 'refactor per signal'}. No change to external behavior.`,
    ``,
    `## Components to build / modify`,
    `- ${file} — ${snap.suggested_action || 'refactor'}`,
    `- ${testFile} — add/adjust tests to cover the change`,
    ``,
    `## Files to modify`,
    `- ${file}`,
    `- ${testFile}`,
    ``,
    `## Reused primitives`,
    `None beyond existing module APIs.`,
    ``,
    `## Implementation order`,
    `1. Apply the change to ${base}`,
    `2. Run tests locally`,
    `3. Commit + open PR`,
    ``,
    `## Verification`,
    `- Unit tests pass`,
    `- Typecheck clean`,
    `- Deploy smoke green`,
    ``,
    `## Out of scope`,
    `- Unrelated refactors in surrounding modules`,
  ];
  return lines.join('\n');
}

// =============================================================================
// Run a Managed Agents planning session
// =============================================================================

async function runPlanningSession(
  finding: FindingForPlanning,
  previousPlan: string | undefined,
  feedbackNote: string | undefined,
): Promise<{ ok: boolean; plan_markdown?: string; session_id?: string; error?: string }> {
  if (!ANTHROPIC_API_KEY) {
    console.warn(`${LOG_PREFIX} ANTHROPIC_API_KEY unset — emitting stub plan for ${finding.id}`);
    return {
      ok: true,
      plan_markdown: buildStubPlan(finding, feedbackNote),
      session_id: `stub_${randomUUID().slice(0, 8)}`,
    };
  }

  const { agent_id, environment_id } = getAgentIds();

  const sessionResult = await anthropicRequest<{ id: string }>('/v1/sessions', {
    method: 'POST',
    body: {
      agent: { type: 'agent', id: agent_id, version: 1 },
      environment_id,
      title: `Dev Autopilot plan: ${finding.id}`,
      resources: [
        {
          type: 'github_repository',
          url: 'https://github.com/exafyltd/vitana-platform',
          authorization_token: process.env.GITHUB_SAFE_MERGE_TOKEN || '',
          mount_path: '/workspace/repo',
          checkout: { type: 'branch', name: 'main' },
        },
      ],
    },
  });
  if (!sessionResult.ok || !sessionResult.data) {
    return { ok: false, error: `Session creation failed: ${sessionResult.error}` };
  }
  const sessionId = sessionResult.data.id;

  await anthropicRequest(`/v1/sessions/${sessionId}/events`, {
    method: 'POST',
    body: {
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text: buildPlanningPrompt(finding, previousPlan, feedbackNote) }],
        },
      ],
    },
  });

  const seenIds = new Set<string>();
  const textParts: string[] = [];
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  let done = false;

  while (!done && Date.now() < deadline) {
    const eventsResult = await anthropicRequest<{ data?: Array<{ id: string; type: string; content?: Array<{ type: string; text?: string }>; stop_reason?: { type?: string } }> }>(
      `/v1/sessions/${sessionId}/events`,
    );
    if (!eventsResult.ok) {
      return { ok: false, error: `Events poll failed: ${eventsResult.error}`, session_id: sessionId };
    }
    const events = eventsResult.data?.data || [];
    for (const event of events) {
      if (seenIds.has(event.id)) continue;
      seenIds.add(event.id);
      if (event.type === 'agent.message' && event.content) {
        for (const block of event.content) {
          if (block.type === 'text' && block.text) textParts.push(block.text);
        }
      } else if (event.type === 'session.status_idle') {
        if (event.stop_reason?.type !== 'requires_action') done = true;
      } else if (event.type === 'session.status_terminated') {
        done = true;
      }
    }
    if (!done && events.length === 0) await new Promise(r => setTimeout(r, 2000));
  }

  const planMarkdown = textParts.join('\n').trim();
  if (!planMarkdown) {
    return { ok: false, error: 'Agent produced no plan output', session_id: sessionId };
  }
  return { ok: true, plan_markdown: planMarkdown, session_id: sessionId };
}

// =============================================================================
// Public API — generate a plan version
// =============================================================================

export async function generatePlanVersion(
  findingId: string,
  opts: { feedback_note?: string } = {},
): Promise<PlanningResult> {
  const supa = getSupabase();
  if (!supa) return { ok: false, error: 'Supabase not configured' };

  // 1. Load the finding
  const recR = await supaRequest<FindingForPlanning[]>(
    supa,
    `/rest/v1/autopilot_recommendations?id=eq.${findingId}&select=id,title,summary,domain,risk_class,spec_snapshot&limit=1`,
  );
  if (!recR.ok || !recR.data) return { ok: false, error: recR.error || 'finding lookup failed' };
  const finding = recR.data[0];
  if (!finding) return { ok: false, error: 'finding not found' };

  // 2. Load the previous plan version (if continue-planning)
  let previousPlan: string | undefined;
  let nextVersion = 1;
  if (opts.feedback_note) {
    const prevR = await supaRequest<Array<{ version: number; plan_markdown: string }>>(
      supa,
      `/rest/v1/dev_autopilot_plan_versions?finding_id=eq.${findingId}&order=version.desc&limit=1`,
    );
    if (prevR.ok && prevR.data && prevR.data[0]) {
      previousPlan = prevR.data[0].plan_markdown;
      nextVersion = prevR.data[0].version + 1;
    }
  } else {
    // First-time generation: only insert v1 if none exists
    const existingR = await supaRequest<Array<{ version: number }>>(
      supa,
      `/rest/v1/dev_autopilot_plan_versions?finding_id=eq.${findingId}&order=version.desc&limit=1`,
    );
    if (existingR.ok && existingR.data && existingR.data[0]) {
      nextVersion = existingR.data[0].version + 1;
    }
  }

  // 3. Run the planning session
  const session = await runPlanningSession(finding, previousPlan, opts.feedback_note);
  if (!session.ok || !session.plan_markdown) {
    await emitOasisEvent({
      vtid: PLAN_VTID,
      type: 'dev_autopilot.plan.failed',
      source: 'dev-autopilot',
      status: 'error',
      message: `Plan generation failed for ${findingId}: ${session.error}`,
      payload: { finding_id: findingId, error: session.error, session_id: session.session_id },
    });
    return { ok: false, error: session.error || 'planning failed' };
  }

  const files_referenced = extractFilePaths(session.plan_markdown);
  const plan_html = renderPlanHtml(session.plan_markdown);

  // 4. Persist plan version
  const insertR = await supaRequest(supa, '/rest/v1/dev_autopilot_plan_versions', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      finding_id: findingId,
      version: nextVersion,
      plan_markdown: session.plan_markdown,
      plan_html,
      planning_session_id: session.session_id,
      feedback_note: opts.feedback_note || null,
      files_referenced,
    }),
  });
  if (!insertR.ok) {
    return { ok: false, error: `plan insert failed: ${insertR.error}` };
  }

  await emitOasisEvent({
    vtid: PLAN_VTID,
    type: nextVersion === 1 ? 'dev_autopilot.plan.generated' : 'dev_autopilot.plan.version_added',
    source: 'dev-autopilot',
    status: 'success',
    message: `Plan v${nextVersion} generated for ${findingId} (${files_referenced.length} files cited)`,
    payload: { finding_id: findingId, version: nextVersion, session_id: session.session_id, files: files_referenced },
  });

  return {
    ok: true,
    plan: {
      finding_id: findingId,
      version: nextVersion,
      plan_markdown: session.plan_markdown,
      plan_html,
      planning_session_id: session.session_id,
      feedback_note: opts.feedback_note,
      files_referenced,
    },
  };
}

// =============================================================================
// Eager top-K planning — called from synthesis after Stage A ingest
// =============================================================================

export async function eagerlyPlanTopK(runId: string, k: number): Promise<{ planned: number; errors: number }> {
  const supa = getSupabase();
  if (!supa) return { planned: 0, errors: 0 };

  // Pick newly-inserted findings from this run, ordered by impact desc × risk_class
  // (risk=low ranks above medium above high because high is ineligible anyway;
  // the UI still shows them, but we don't waste tokens planning them eagerly).
  const r = await supaRequest<Array<{ id: string; risk_class: string | null }>>(
    supa,
    `/rest/v1/autopilot_recommendations?source_type=eq.dev_autopilot&source_run_id=eq.${runId}&status=eq.new&risk_class=in.(low,medium)&order=impact_score.desc&limit=${k}&select=id,risk_class`,
  );
  if (!r.ok || !r.data) return { planned: 0, errors: 0 };

  let planned = 0;
  let errors = 0;
  for (const row of r.data) {
    const result = await generatePlanVersion(row.id);
    if (result.ok) planned++; else errors++;
  }
  return { planned, errors };
}

// =============================================================================
// Exports
// =============================================================================

export { buildPlanningPrompt, buildStubPlan, LOG_PREFIX };
