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
import { isWorkerQueueEnabled, runWorkerTask } from './dev-autopilot-worker-queue';
import { writeAutopilotFailure, isWorkerBinaryMissing } from './dev-autopilot-self-heal-log';
import { loadAutopilotContext } from './dev-autopilot/context-loader';
import { isTestFile } from './dev-autopilot-safety';
import {
  extractTableNames,
  loadSchemaSnippets,
  formatSchemaBlock,
} from './dev-autopilot-schema-context';

const LOG_PREFIX = '[dev-autopilot-planning]';
const PLAN_VTID = 'VTID-DEV-AUTOPILOT';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_BASE = 'https://api.anthropic.com';
// LLM call timeout. Applies whether we're using the direct Messages API
// path or the worker-queue path.
//
//   Direct API:       15-45s typical, 240s was the original guard.
//   Worker queue:     subprocess overhead + larger contexts bring this
//                     up to ~200-300s in practice (observed 267s on a
//                     first real call against WSL + busy workstation).
//
// Cloud Run request ceiling is 300s — the lazy plan endpoint is request-
// scoped so we can't go above that. Eager planning is background-ticker
// scoped and tolerates a longer wait, so when the worker queue is in use
// we extend to 480s for the executor path (see dev-autopilot-execute.ts);
// the /generate-plan request handler still caps at 280s to stay inside
// Cloud Run's wall. If the subprocess doesn't finish in that window we
// return a timeout error to the UI and leave the queue row around — the
// worker's result is not lost, it's just orphaned, and the next
// regeneration attempt picks up from the same inputs.
const MESSAGES_TIMEOUT_MS = 280_000;
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

/**
 * BOOTSTRAP-LLM-ROUTER (Phase D): plan-gen direct-API call now goes through
 * the provider router. The router reads llm_routing_policy.policy.planner
 * and dispatches to the configured provider (default Vertex / gemini-2.5-pro
 * with Anthropic / claude-opus-4-7 fallback). Operators flip providers via
 * the Command Hub dropdown without code edits.
 *
 * This path only fires when the worker queue is unavailable (worker daemon
 * dead, binary missing) — the worker queue path at runPlanningSession()
 * remains the primary, free Claude-subscription route.
 *
 * Return shape preserved so callers don't change.
 */
async function callMessagesApi(
  prompt: string,
  vtid?: string | null,
): Promise<{ ok: boolean; text?: string; usage?: MessagesResponse['usage']; error?: string }> {
  // Lazy import to avoid a circular dep at module init time.
  const { callViaRouter } = await import('./llm-router');
  const r = await callViaRouter('planner', prompt, {
    vtid: vtid ?? null,
    service: 'dev-autopilot-planning',
    allowFallback: true,
    maxTokens: 8000,
  });
  if (!r.ok) {
    return { ok: false, error: r.error || 'router returned ok=false' };
  }
  return {
    ok: true,
    text: r.text,
    usage: r.usage
      ? { input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens }
      : undefined,
  };
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
// Prompt-gap feedback — pull recent validation failures for the same scanner
// so plan prompts can warn Claude off known traps.
// =============================================================================

export interface PromptLesson {
  pattern_type: string;
  pattern_key: string;
  example_message: string;
  mitigation_note: string | null;
  last_seen_at: string;
}

/**
 * Load up to `limit` recent validation failures for a given scanner. Best-
 * effort — a DB hiccup here must not block plan generation, so we swallow
 * errors and return an empty list.
 */
export async function loadRecentLessons(
  supa: SupaConfig,
  scanner: string | null | undefined,
  limit = 5,
): Promise<PromptLesson[]> {
  if (!scanner) return [];
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const r = await supaRequest<PromptLesson[]>(
      supa,
      `/rest/v1/dev_autopilot_prompt_learnings?scanner=eq.${encodeURIComponent(scanner)}`
      + `&last_seen_at=gte.${since}`
      + `&order=last_seen_at.desc&limit=${limit}`
      + `&select=pattern_type,pattern_key,example_message,mitigation_note,last_seen_at`,
    );
    return r.ok && Array.isArray(r.data) ? r.data : [];
  } catch {
    return [];
  }
}

function formatLessonsBlock(lessons: PromptLesson[]): string {
  if (!lessons || lessons.length === 0) return '';
  const lines: string[] = [
    ``,
    `## Lessons from prior attempts on findings from this scanner`,
    ``,
    `These validation failures have surfaced recently on similar findings.`,
    `Avoid repeating them in this plan.`,
    ``,
  ];
  for (const l of lessons) {
    const header = l.mitigation_note && l.mitigation_note.trim().length > 0
      ? l.mitigation_note.trim()
      : `${l.pattern_type}: ${l.pattern_key}`;
    lines.push(`- **${header}**`);
    const example = (l.example_message || '').trim().split('\n')[0].slice(0, 240);
    if (example) lines.push(`  Example: ${example}`);
  }
  lines.push(``);
  return lines.join('\n');
}

// =============================================================================
// Prompt builder
// =============================================================================

export function buildPlanningPrompt(
  finding: FindingForPlanning,
  previousPlan?: string,
  feedbackNote?: string,
  scope?: { allow?: string[]; deny?: string[] },
  lessons?: PromptLesson[],
  schemaBlock?: string,
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
    `## Codebase conventions + imports surface`,
    ``,
    `READ THIS FIRST. Reference these rules in your Files-to-modify and`,
    `Implementation steps so the executor doesn't hallucinate APIs or`,
    `produce non-conforming filenames.`,
    ``,
    loadAutopilotContext(),
    ``,
    `---`,
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

  // VTID-02672: when the finding came from a feedback ticket (Devon's
  // spec workflow), the bridge already pre-validated `proposed_files`
  // against allow/deny scope. The planner MUST use only those paths so
  // the safety gate doesn't reject the plan after Devon wrote a clean
  // spec. Co-located test files (`.test.ts` next to the source) are
  // allowed automatically since they're in the same allow-scope.
  const proposedFiles = (snap as { proposed_files?: string[] }).proposed_files;
  if (snap.signal_type === 'feedback_ticket' && Array.isArray(proposedFiles) && proposedFiles.length > 0) {
    lines.push(
      `## LOCKED file list (feedback ticket — DO NOT DEVIATE)`,
      ``,
      `This finding came from a feedback ticket. The pre-flight already`,
      `validated these file paths against the allow-scope and deny-scope.`,
      `Your Files-to-modify section MUST contain ONLY these paths (plus`,
      `co-located \`.test.ts\` files if you need new tests):`,
      ``,
      ...proposedFiles.map(f => `- \`${f}\``),
      ``,
      `Do NOT add additional source files. Do NOT swap a path for a`,
      `different one. If a path here doesn't actually exist in the repo`,
      `(GitHub fetch returned 404 in the Referenced file section), state`,
      `that explicitly in the Out-of-scope section and propose to CREATE`,
      `the file at that path. Do not silently use a different path.`,
      ``,
    );
  }

  // VTID-02640: live DB schema for any tables referenced in the flagged
  // file. Inserted EARLY in the prompt so column-name hallucinations
  // (e.g. PR #1091's wrong vitana_id -> vuid rename) are short-circuited
  // before the LLM starts thinking about edits. Empty string is a no-op.
  if (schemaBlock) lines.push(schemaBlock);

  // VTID-02640: hard rules to suppress the most damaging classes of
  // hallucination we've seen ship in PRs: migration modifications and
  // unverified column renames. These rules supplement (not replace) the
  // safety gate's allow/deny scope check + the deny_scope on migrations.
  lines.push(
    `## Critical anti-hallucination rules (read before producing the plan)`,
    ``,
    `1. **Never modify any file under \`supabase/migrations/\`.** Migrations`,
    `   are append-only after they are applied. If schema needs to change,`,
    `   add a NEW dated migration file (\`supabase/migrations/YYYYMMDDHHMMSS_<purpose>.sql\`)`,
    `   and put the new file in Files-to-modify. Modifying an applied`,
    `   migration is the failure mode behind closed PR #1086.`,
    ``,
    `2. **Never propose a column rename, table rename, or schema-drift fix`,
    `   without verifying the columns in the Live DB schema section above`,
    `   (or in an attached migration file).** If a column you want to`,
    `   reference does not appear in the schema section, treat it as`,
    `   "may not exist" and write the plan to investigate, not to rename.`,
    `   Closed PR #1091 proposed renaming \`vitana_id\` -> \`vuid\` because`,
    `   the planner inferred from filename patterns alone — \`vuid\` does`,
    `   not exist; the canonical column is \`vitana_id\`.`,
    ``,
    `3. **Files-to-modify must match the diff your executor will produce.**`,
    `   Do not list files for "the developer to verify" — those go in`,
    `   Out-of-scope. The executor writes exactly the listed files; if a`,
    `   file is not listed, no edits are made to it.`,
    ``,
  );

  // Prompt-gap feedback loop — inject recent validation failures scoped to
  // this scanner so Claude doesn't repeat known traps.
  const lessonsBlock = formatLessonsBlock(lessons || []);
  if (lessonsBlock) lines.push(lessonsBlock);

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

  // HARD CONSTRAINT on the Files to modify section — the safety gate rejects
  // approvals whose plan cites any path outside allow_scope or any path in
  // deny_scope, so a plan that puts config files in that section is
  // guaranteed to be blocked. Surface the constraint as part of the prompt
  // so Claude puts reference-only files in a separate section instead.
  const allow = scope?.allow && scope.allow.length > 0 ? scope.allow : undefined;
  const deny = scope?.deny && scope.deny.length > 0 ? scope.deny : undefined;
  if (allow || deny) {
    lines.push(
      `## Scope constraints (enforced automatically — violations block approval)`,
      ``,
      `The "Files to modify" section must contain ONLY paths that the executor`,
      `will actually create, modify, or delete. Do NOT list config files or`,
      `dependency manifests there for the developer to "double-check" — put`,
      `those as plain-text notes in the Out-of-scope section instead.`,
      ``,
    );
    if (allow) {
      lines.push(`Files to modify MUST match one of these allow-scope globs:`);
      for (const g of allow) lines.push(`  - \`${g}\``);
      lines.push(``);
    }
    if (deny) {
      lines.push(`Files to modify MUST NOT match any of these deny-scope globs:`);
      for (const g of deny) lines.push(`  - \`${g}\``);
      lines.push(``);
    }
    // Scanner-aware trap list. The blanket "never modify package.json /
    // migrations / workflows / etc." rule was added to stop the planner
    // from sneaking config files into unrelated plans, but it became the
    // dominant reason autopilot PRs couldn't actually fix anything: an
    // npm-audit-scanner-v1 finding's only valid fix IS bumping
    // package.json, an rls-policy-scanner-v1 finding's only valid fix IS
    // a new migration, etc. The 2026-05-08 audit found these scanners
    // produced test-only PRs that fail CI 100% of the time because the
    // actual fix was forbidden. Below, each trap is gated on the
    // scanner of THIS finding so the trap fires for every UNRELATED
    // finding (preserving the original protection) but is lifted for
    // findings whose category legitimately requires touching that file
    // type.
    const scanner = String(snap.scanner || '');
    const trapBullets: string[] = [];
    if (scanner !== 'npm-audit-scanner-v1' && scanner !== 'cve-scanner-v1') {
      trapBullets.push(
        `  - \`services/gateway/package.json\` / any \`package.json\` ` +
          `(this finding's scanner is not the dependency-audit scanner — ` +
          `if a dep change is genuinely needed, surface it in Out-of-scope)`,
      );
    }
    trapBullets.push(
      `  - \`services/gateway/tsconfig.json\` / any \`tsconfig*.json\``,
      `  - \`services/gateway/jest.config.ts\` / any \`jest.config.*\``,
    );
    if (scanner !== 'workflow-fix-scanner-v1' && scanner !== 'ci-fix-scanner-v1') {
      trapBullets.push(`  - Any \`.github/workflows/*\` file`);
    }
    // Migration MODIFICATIONS are never allowed (rule #1 above), but new
    // dated migration files ARE the canonical fix for schema-drift /
    // rls-policy findings. The blanket trap was wrong here.
    if (scanner !== 'rls-policy-scanner-v1' && scanner !== 'schema-drift-scanner-v1') {
      trapBullets.push(`  - Any \`supabase/migrations/*\` file`);
    } else {
      trapBullets.push(
        `  - **Modifying** any existing \`supabase/migrations/*\` file (per ` +
          `rule #1 above; ADDING a new dated migration file IS allowed for this scanner)`,
      );
    }
    trapBullets.push(`  - Any path containing \`auth\` unless it IS the finding's target`);
    lines.push(
      `Common traps — do NOT put these in Files to modify:`,
      ...trapBullets,
      ``,
      `If the developer needs to verify a forbidden file, write a bullet in`,
      `Out-of-scope like: "Developer should verify supertest is in`,
      `services/gateway/package.json devDependencies" — NOT a line in`,
      `Files to modify.`,
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
    `(Flat list of repo-relative paths, one per line. Include test files.`,
    ` Every path here MUST pass the scope constraints above — no config files,`,
    ` no package.json, no tsconfig, no jest.config. The executor writes exactly`,
    ` these files and no others.)`,
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
    `(Things intentionally not in this change. Put "developer should verify"`,
    ` notes about config files HERE, not in Files to modify.)`,
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
  // VTID-02679: tolerate "Files to touch" / "Files to change" / "Files to edit"
  // and the hyphenated "Files-to-modify". Devon's spec uses "Files to touch"
  // so the planner often inherits that phrasing when echoing the LOCKED file
  // list — without this, plans look empty and dispatch fails with
  // "plan has no files_referenced".
  const filesSection = markdown.match(/##\s*Files\s*[- ]\s*to\s*[- ]\s*(?:modify|touch|change|edit)[\s\S]+?(?=\n##\s|$)/i);
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
  scope?: { allow?: string[]; deny?: string[] },
  supa?: SupaConfig,
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

  // Pull recent validation lessons for this scanner so Claude can avoid
  // known traps. Best-effort — never blocks plan generation.
  const lessons = supa
    ? await loadRecentLessons(supa, finding.spec_snapshot?.scanner)
    : [];

  const startedAt = Date.now();
  const filePath = finding.spec_snapshot?.file_path;
  let fileSection = '';
  let fileContent: string | null = null;

  if (filePath) {
    const fileR = await fetchFileFromGitHub(filePath);
    if (fileR.ok && typeof fileR.content === 'string') {
      fileContent = fileR.content;
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

  // VTID-02640: pre-fetch live schema for tables referenced in the file.
  // Best-effort — fetch failure or missing supa just means the planner runs
  // without schema context, same as before.
  let schemaBlock = '';
  if (supa && fileContent) {
    try {
      const tables = extractTableNames(fileContent);
      if (tables.length > 0) {
        const rows = await loadSchemaSnippets(supa, tables);
        schemaBlock = formatSchemaBlock(rows);
        if (rows.length > 0) {
          console.log(
            `${LOG_PREFIX} schema context: ${rows.length} cols across ${tables.length} tables for ${finding.id}`,
          );
        }
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} schema-context fetch threw for ${finding.id}:`, err);
    }
  }

  const prompt = buildPlanningPrompt(finding, previousPlan, feedbackNote, scope, lessons, schemaBlock) + fileSection;

  // Route through the local worker queue when enabled, so the LLM call draws
  // on the Claude subscription instead of the pay-per-token API key. Falls
  // back to the direct Messages API call when the feature flag is off.
  let call = isWorkerQueueEnabled()
    ? await runWorkerTask(
        {
          kind: 'plan',
          finding_id: finding.id,
          prompt,
          model: PLANNING_MODEL,
          max_tokens: 8_000,
          notes: `plan ${finding.id} — ${feedbackNote ? 'continue' : 'first'}`,
        },
        { timeoutMs: MESSAGES_TIMEOUT_MS },
      )
    : await callMessagesApi(prompt, `VTID-DA-FIND-${finding.id.slice(0, 8)}`);

  // Auto-fallback for the worker-binary-missing failure: when the worker
  // can't spawn the Claude Code CLI (ENOENT, binary path stale after an
  // extension update, etc.), retry once via the direct Messages API path.
  // This is the kind of self-healing the "fully autonomous" goal requires:
  // detect a known dependency failure and route around it without human
  // intervention. ANTHROPIC_API_KEY must be set for the fallback to work;
  // if it's missing, we still surface the failure on self_healing_log.
  let fallback_used = false;
  if (!call.ok && isWorkerQueueEnabled() && isWorkerBinaryMissing(call.error) && ANTHROPIC_API_KEY) {
    console.warn(`${LOG_PREFIX} worker binary missing — falling back to Messages API for ${finding.id}`);
    call = await callMessagesApi(prompt, `VTID-DA-FIND-${finding.id.slice(0, 8)}`);
    fallback_used = true;
  }
  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  if (!call.ok || !call.text) {
    const supaForLog = getSupabase();
    if (supaForLog) {
      const isBinaryMissing = isWorkerBinaryMissing(call.error);
      await writeAutopilotFailure(supaForLog, {
        stage: 'plan_gen',
        vtid: `VTID-DA-FIND-${finding.id.slice(0, 8)}`,
        endpoint: finding.spec_snapshot?.file_path || `autopilot.plan_gen`,
        failure_class: isBinaryMissing
          ? 'dev_autopilot_worker_binary_missing'
          : 'dev_autopilot_plan_gen_failed',
        confidence: 0,
        diagnosis: {
          summary: isBinaryMissing
            ? 'Worker process cannot spawn Claude Code CLI (binary moved or PATH changed). Restart worker or update binary path. Fallback to Messages API also failed (or ANTHROPIC_API_KEY unset).'
            : `Plan generation failed after ${elapsed}s: ${call.error || 'unknown error'}`,
          finding_id: finding.id,
          finding_title: finding.title,
          scanner: finding.spec_snapshot?.scanner,
          file_path: finding.spec_snapshot?.file_path,
          worker_used: isWorkerQueueEnabled(),
          fallback_attempted: fallback_used,
          elapsed_s: elapsed,
          raw_error: (call.error || '').slice(0, 500),
        },
        outcome: 'escalated',
        attempt_number: 1,
      });
    }
    return {
      ok: false,
      error: `Plan generation failed after ${elapsed}s: ${call.error || 'unknown error'}`,
      session_id: sessionId,
    };
  }

  console.log(
    `${LOG_PREFIX} plan generated for ${finding.id} in ${elapsed}s via ${isWorkerQueueEnabled() ? 'worker-queue' : 'messages-api'} (${call.usage?.input_tokens || '?'} in / ${call.usage?.output_tokens || '?'} out tokens)`,
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

  // 3. Load scope from config so the LLM can be told the hard constraints
  // in the prompt. If the config isn't reachable, fall through with
  // undefined — the prompt will still list the common traps.
  let scope: { allow?: string[]; deny?: string[] } | undefined;
  const cfgR = await supaRequest<Array<{ allow_scope: string[]; deny_scope: string[] }>>(
    supa,
    `/rest/v1/dev_autopilot_config?id=eq.1&select=allow_scope,deny_scope&limit=1`,
  );
  if (cfgR.ok && cfgR.data && cfgR.data[0]) {
    scope = { allow: cfgR.data[0].allow_scope, deny: cfgR.data[0].deny_scope };
  }

  // 4. Run the planning session
  const initialSession = await runPlanningSession(finding, previousPlan, opts.feedback_note, scope, supa);
  if (!initialSession.ok || !initialSession.plan_markdown) {
    await emitOasisEvent({
      vtid: PLAN_VTID,
      type: 'dev_autopilot.plan.failed',
      source: 'dev-autopilot',
      status: 'error',
      message: `Plan generation failed for ${findingId}: ${initialSession.error}`,
      payload: { finding_id: findingId, error: initialSession.error, session_id: initialSession.session_id },
    });
    return { ok: false, error: initialSession.error || 'planning failed' };
  }
  // Bind to non-undefined locals so the retry branch below can update them
  // without losing TypeScript's narrowing across reassignment.
  let plan_markdown: string = initialSession.plan_markdown;
  let session_id: string | undefined = initialSession.session_id;

  // VTID-02680: for feedback-bridged findings, the bridge has already
  // pre-validated `proposed_files` against allow_scope/deny_scope. Trust
  // that list directly instead of round-tripping through the planner's
  // free-form markdown output. Eliminates dependency on the planner LLM
  // producing a recognisable "Files to ..." section heading — which it
  // doesn't reliably do, leading to "plan has no files_referenced" loops.
  // For non-feedback findings, fall back to the markdown extractor.
  const proposedFiles = (finding.spec_snapshot as { proposed_files?: unknown })?.proposed_files;
  const isFeedbackLane = (finding.spec_snapshot as { signal_type?: string })?.signal_type === 'feedback_ticket';
  let files_referenced = (isFeedbackLane && Array.isArray(proposedFiles) && proposedFiles.length > 0)
    ? (proposedFiles as string[]).filter(p => typeof p === 'string' && p.includes('/'))
    : extractFilePaths(plan_markdown);

  // VTID-AUTOPILOT-PLAN-TESTS: auto-retry-once if the plan lacks test files.
  // The safety gate at approval time rejects any non-deletion-only plan
  // missing a test file. The planner prompt mentions "Include test files"
  // but the model often drops it. Catching this at plan-generation time
  // and re-running once with explicit feedback raises first-time-pass
  // rate substantially without burning the executor's LLM call. Skip
  // when:
  //   - This is already a continue-planning call (opts.feedback_note set).
  //     A second forced retry on top of a human-driven retry would silently
  //     overwrite the human's feedback intent.
  //   - All listed files are tests (e.g., "missing tests" findings whose
  //     scope IS test files only).
  //   - All listed files are deletions only (no isDeletion check yet — use
  //     a markdown heuristic on "## Files to delete" presence as a proxy).
  const looksDeletionsOnly = /##\s*Files\s+to\s+(?:delete|remove)/i.test(plan_markdown)
    && !/##\s*Files\s+to\s+(?:modify|touch|change|edit|create|add)/i.test(plan_markdown);
  const hasTestFile = files_referenced.some(p => isTestFile(p));
  if (!hasTestFile && !looksDeletionsOnly && !opts.feedback_note && files_referenced.length > 0) {
    console.log(
      `${LOG_PREFIX} plan v${nextVersion} for ${findingId.slice(0, 8)} lacks test files — auto-retrying once with explicit feedback`,
    );
    const testFeedback = `Your previous plan listed ${files_referenced.length} file(s) but no test file. The safety gate REQUIRES at least one test file when the plan makes any non-deletion edits. Test files end in \`.test.ts\` / \`.test.tsx\` / \`.spec.ts\`. Regenerate the plan adding the matching co-located test file (or a new one under \`services/gateway/test/\` or \`services/gateway/tests/\`) and include it in the "Files to modify" section.`;
    const retrySession = await runPlanningSession(finding, plan_markdown, testFeedback, scope, supa);
    if (retrySession.ok && retrySession.plan_markdown) {
      plan_markdown = retrySession.plan_markdown;
      session_id = retrySession.session_id;
      files_referenced = (isFeedbackLane && Array.isArray(proposedFiles) && proposedFiles.length > 0)
        ? (proposedFiles as string[]).filter(p => typeof p === 'string' && p.includes('/'))
        : extractFilePaths(plan_markdown);
      const retryHasTest = files_referenced.some(p => isTestFile(p));
      console.log(
        `${LOG_PREFIX} plan v${nextVersion} for ${findingId.slice(0, 8)} retry result: ${files_referenced.length} files, hasTest=${retryHasTest}`,
      );
    } else {
      console.warn(
        `${LOG_PREFIX} plan v${nextVersion} for ${findingId.slice(0, 8)} retry failed: ${retrySession.error} — proceeding with original plan (safety gate may block)`,
      );
    }
  }
  if (isFeedbackLane && Array.isArray(proposedFiles)) {
    console.log(`${LOG_PREFIX} feedback finding ${findingId}: using bridge-validated files (${files_referenced.length}) instead of planner extraction`);
  }
  const plan_html = renderPlanHtml(plan_markdown);

  // 4. Persist plan version
  const insertR = await supaRequest(supa, '/rest/v1/dev_autopilot_plan_versions', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      finding_id: findingId,
      version: nextVersion,
      plan_markdown,
      plan_html,
      planning_session_id: session_id,
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
    payload: { finding_id: findingId, version: nextVersion, session_id, files: files_referenced },
  });

  return {
    ok: true,
    plan: {
      finding_id: findingId,
      version: nextVersion,
      plan_markdown,
      plan_html,
      planning_session_id: session_id,
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

export { buildStubPlan, LOG_PREFIX };
