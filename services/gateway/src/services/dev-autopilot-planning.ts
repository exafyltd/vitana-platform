/**
 * Developer Autopilot — Stage B Planning (direct Messages API)
 *
 * Given a finding (autopilot_recommendations row), calls the Anthropic
 * Messages API with the referenced file content pre-fetched from GitHub
 * and asks Claude to produce a complete plan_markdown in the canonical
 * structure (Context / Target flow / Components / Files / Reused
 * primitives / Implementation order / Verification / Out of scope).
 *
 * History / why NOT Managed Agents:
 *   An earlier revision wired this through the Managed Agents API with
 *   a GitHub repo mount. Every call hit the Cloud Run 300s request
 *   timeout (plan.failed events, 2026-04-18..19) because the agent spent
 *   all of its budget exploring the repo and never produced the final
 *   plan text. Messages API with the file content pre-attached returns
 *   in ~20-60s and is well within Cloud Run's window.
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
// Messages API hard timeout. Cloud Run request timeout is 300s, so cap at
// 240s and leave 60s of headroom for file fetch + Supabase persist + response
// flush. Claude Sonnet 4.6 finishes a plan of this shape in ~15-45s; 240s
// is only to guard against the API itself stalling.
const MESSAGES_TIMEOUT_MS = 240_000;
// Model used for planning. Claude Sonnet 4.6 is the right balance of depth
// and latency for this task; Opus is overkill and slower. Override with
// DEV_AUTOPILOT_PLANNING_MODEL if needed.
const PLANNING_MODEL = process.env.DEV_AUTOPILOT_PLANNING_MODEL || 'claude-sonnet-4-6';

// How much of the referenced file to include verbatim in the prompt.
// 600k chars ≈ 150k tokens — well within Sonnet 4.6's 200k context window
// once we add the prompt + headroom for the response.
const FILE_MAX_CHARS = 600_000;
// When the file exceeds FILE_MAX_CHARS, give the model the head, tail, and
// a window around the flagged line_number.
const FILE_HEAD_LINES = 300;
const FILE_TAIL_LINES = 300;
const FILE_FOCUS_WINDOW_LINES = 400;

const GITHUB_REPO = process.env.DEV_AUTOPILOT_REPO || 'exafyltd/vitana-platform';
const GITHUB_REF = process.env.DEV_AUTOPILOT_REF || 'main';

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
// Anthropic Messages API + GitHub + Supabase helpers
// =============================================================================

interface MessagesResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

async function callMessagesApi(
  prompt: string,
): Promise<{ ok: boolean; text?: string; usage?: MessagesResponse['usage']; error?: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), MESSAGES_TIMEOUT_MS);
  try {
    const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: PLANNING_MODEL,
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 500)}` };
    }
    const data = (await res.json()) as MessagesResponse;
    const text = (data.content || [])
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text as string)
      .join('\n')
      .trim();
    if (!text) return { ok: false, error: 'Messages API returned no text content', usage: data.usage };
    return { ok: true, text, usage: data.usage };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: `Messages API aborted after ${MESSAGES_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFileFromGitHub(
  filePath: string,
): Promise<{ ok: boolean; content?: string; status?: number; error?: string }> {
  const token = process.env.GITHUB_SAFE_MERGE_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!token) return { ok: false, error: 'GITHUB_SAFE_MERGE_TOKEN not set' };
  // Normalize path — drop leading slash, URL-encode segments but keep '/'.
  const clean = filePath.replace(/^\/+/, '');
  const encoded = clean.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encoded}?ref=${encodeURIComponent(GITHUB_REF)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3.raw',
        'User-Agent': 'vitana-dev-autopilot-planner',
      },
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { ok: false, status: res.status, error: `${res.status}: ${body}` };
    }
    const content = await res.text();
    return { ok: true, content, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function buildFileContext(content: string, lineNumber: number | undefined, path: string): string {
  const totalLines = content.split('\n').length;
  if (content.length <= FILE_MAX_CHARS) {
    return [
      `\`\`\`${inferFenceLang(path)}`,
      `// ${path} — ${totalLines} lines (full file below)`,
      content.length > 0 ? content : '(empty file)',
      `\`\`\``,
    ].join('\n');
  }
  // Too big — slice head, tail, and a window around the flagged line.
  const lines = content.split('\n');
  const focus = lineNumber && lineNumber > 0 ? Math.min(lineNumber, totalLines) : Math.floor(totalLines / 2);
  const halfWin = Math.floor(FILE_FOCUS_WINDOW_LINES / 2);
  const winStart = Math.max(0, focus - halfWin);
  const winEnd = Math.min(totalLines, focus + halfWin);
  const head = lines.slice(0, FILE_HEAD_LINES).join('\n');
  const mid = lines.slice(winStart, winEnd).join('\n');
  const tail = lines.slice(Math.max(totalLines - FILE_TAIL_LINES, winEnd), totalLines).join('\n');
  const fence = inferFenceLang(path);
  return [
    `> Note: ${path} is ${totalLines} lines (${content.length.toLocaleString()} chars) — too large to inline in full.`,
    `> The excerpts below are: HEAD (lines 1–${FILE_HEAD_LINES}), FOCUS (lines ${winStart + 1}–${winEnd} around flagged line ${focus}), TAIL (last ${FILE_TAIL_LINES} lines).`,
    ``,
    `\`\`\`${fence}`,
    `// ${path} — HEAD (lines 1–${FILE_HEAD_LINES})`,
    head,
    `\`\`\``,
    ``,
    `\`\`\`${fence}`,
    `// ${path} — FOCUS (lines ${winStart + 1}–${winEnd})`,
    mid,
    `\`\`\``,
    ``,
    `\`\`\`${fence}`,
    `// ${path} — TAIL (last ${FILE_TAIL_LINES} lines)`,
    tail,
    `\`\`\``,
  ].join('\n');
}

function inferFenceLang(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', sql: 'sql', yml: 'yaml', yaml: 'yaml', json: 'json', md: 'markdown',
  };
  return map[ext] || '';
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
    if (res.status === 204 || res.status === 201) {
      // Prefer: return=minimal produces 201 with an empty body — don't parse.
      const text = await res.text();
      if (!text) return { ok: true, status: res.status };
      try {
        return { ok: true, status: res.status, data: JSON.parse(text) as T };
      } catch { return { ok: true, status: res.status }; }
    }
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
    `The referenced file is attached below. Use it (plus the finding metadata`,
    `above) to produce a complete, actionable plan. Do NOT ask to see other`,
    `files — infer tests/types/callers by naming conventions and state them`,
    `as candidates in the plan. Cite every file you propose to modify by its`,
    `repo-relative path (e.g. \`services/gateway/src/...\`), matching the style`,
    `of the finding's file path. A plan that cites a nonexistent path will be`,
    `rejected by validation.`,
    ``,
    `If the flagged file is partial (head/focus/tail excerpts only), work`,
    `from what you can see and explicitly note in the plan any areas where`,
    `the developer should double-check sections you couldn't see in full.`,
    ``,
    `## Output format — raw markdown, exactly these section headers, no code fences around the whole document`,
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
    `(Flat list of repo-relative paths, one per line. Include test files.)`,
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

// Extension alternation — longest alternatives first + a trailing negative
// lookahead so ".json" never truncates to ".js" (standard regex alternation
// is left-to-right-first-match, so "js" silently wins over "json" unless we
// order longest-first and anchor the end). Before this fix, every plan that
// referenced `package.json` stored it as `package.js`, which then collided
// with the safety-gate allow_scope check as an out-of-scope file.
const EXT_GROUP = '(?:tsx|ts|jsx|js|sql|yaml|yml|json|md)(?![a-zA-Z0-9])';
const PATH_LINE_RE = new RegExp(
  `(?<![a-zA-Z0-9])((?:services|supabase|scripts|\\.github|specs|src)\\/[a-zA-Z0-9_./\\-]+\\.${EXT_GROUP})`,
  'g',
);
const FILES_SECTION_LINE_RE = new RegExp(`([a-zA-Z0-9_./\\-]+\\.${EXT_GROUP})`);

export function extractFilePaths(markdown: string): string[] {
  const paths = new Set<string>();
  // Prefer the explicit "Files to modify" section. If it exists AND lists at
  // least one path, trust ONLY that list — don't fall back to scanning the
  // whole markdown. The fallback scan is an over-eager safety net that pulls
  // in every path the LLM mentions for context (package.json, jest.config.ts,
  // tsconfig.js, etc.) and flags them as files to modify, which then fails
  // the safety gate's allow_scope check even though the plan never intended
  // to touch them.
  const filesSection = markdown.match(/##\s*Files to modify[\s\S]+?(?=\n##\s|$)/i);
  if (filesSection) {
    for (const line of filesSection[0].split('\n').slice(1)) {
      const match = line.match(FILES_SECTION_LINE_RE);
      if (match && match[1].includes('/')) paths.add(match[1]);
    }
    if (paths.size > 0) return Array.from(paths);
  }
  // Fallback: only if the Files-to-modify section was absent or empty, scan
  // the whole plan for path-like strings. This handles older plans that used
  // the Components-only format.
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
// Run a planning session via Anthropic Messages API
// =============================================================================

async function runPlanningSession(
  finding: FindingForPlanning,
  previousPlan: string | undefined,
  feedbackNote: string | undefined,
): Promise<{ ok: boolean; plan_markdown?: string; session_id?: string; error?: string }> {
  const sessionId = `plan_${randomUUID().slice(0, 12)}`;

  if (!ANTHROPIC_API_KEY) {
    console.warn(`${LOG_PREFIX} ANTHROPIC_API_KEY unset — emitting stub plan for ${finding.id}`);
    return {
      ok: true,
      plan_markdown: buildStubPlan(finding, feedbackNote),
      session_id: sessionId,
    };
  }

  const startedAt = Date.now();
  const filePath = finding.spec_snapshot?.file_path;
  let fileSection = '';

  if (filePath) {
    const fileR = await fetchFileFromGitHub(filePath);
    if (fileR.ok && typeof fileR.content === 'string') {
      fileSection =
        `\n\n## Referenced file\n\n` +
        buildFileContext(fileR.content, finding.spec_snapshot?.line_number, filePath) +
        `\n`;
      console.log(
        `${LOG_PREFIX} fetched ${filePath} (${fileR.content.length} chars) from GitHub for ${finding.id}`,
      );
    } else {
      // File fetch is best-effort. If the path is wrong or the token is
      // missing, still try to produce a useful plan from the finding metadata
      // alone — but include a note so the model knows.
      fileSection = `\n\n## Referenced file\n\n> Could not fetch \`${filePath}\` from GitHub (${fileR.error || 'unknown error'}). Produce the plan from the finding metadata and general knowledge of the repo conventions; flag the file-read failure in the Out-of-scope section.\n`;
      console.warn(
        `${LOG_PREFIX} fetchFileFromGitHub(${filePath}) failed for ${finding.id}: ${fileR.error}`,
      );
    }
  } else {
    fileSection = `\n\n## Referenced file\n\n> No file_path recorded on this finding. Produce the plan from the finding metadata alone.\n`;
  }

  const prompt = buildPlanningPrompt(finding, previousPlan, feedbackNote) + fileSection;

  const call = await callMessagesApi(prompt);
  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  if (!call.ok || !call.text) {
    return {
      ok: false,
      error: `Plan generation failed after ${elapsed}s: ${call.error || 'unknown error'}`,
      session_id: sessionId,
    };
  }

  console.log(
    `${LOG_PREFIX} plan generated for ${finding.id} in ${elapsed}s (${call.usage?.input_tokens || '?'} in / ${call.usage?.output_tokens || '?'} out tokens)`,
  );

  return { ok: true, plan_markdown: call.text, session_id: sessionId };
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
