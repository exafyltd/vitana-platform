/**
 * VTID-04025 (operator agent W4c): memory that accrues from every turn.
 *
 * Gap analysis §4.3. Until now `writeDevMemory` fired for five tool names
 * only (`recordSessionOutcomeMemory`, VTID-03928) — a decision the owner
 * states in chat, a gotcha the console hits, a preference ("always
 * DeepSeek first"), all evaporated with the browser tab. Two producers:
 *
 *   extractAndRecordTurnMemory — after each completed operator turn, the
 *       `memory` routing stage (Bedrock primary / DeepSeek fallback — never
 *       Google) is asked for the durable facts in that turn as a small JSON
 *       array (≤ MAX_ITEMS_PER_TURN, categories restricted to the
 *       dev_agent_memory enum minus task_outcome, which VTID-03928 owns)
 *       and each becomes a dev_agent_memory row. Trivial turns are skipped
 *       before any model call (shouldExtract). Fail-open: a model or write
 *       failure is logged and never touches the reply.
 *   recordExecutionOutcomeMemory — the Dev Autopilot executor records one
 *       task_outcome row when a run opens a PR and one gotcha row when a
 *       run fails (the error already carries the W0 CI log excerpt), so
 *       the next session recalls what actually happened to VTID-xxxxx.
 *
 * Gated on OPERATOR_TURN_MEMORY_ENABLED=true (default off). Executor
 * writes share the gate.
 */

import { callViaRouter } from './llm-router';
import { writeDevMemory, type DevMemoryCategory, type DevMemorySource, type WriteDevMemoryInput } from './dev-agent-memory';

const LOG_PREFIX = '[operator-turn-memory]';
export const MAX_ITEMS_PER_TURN = 3;
export const TITLE_MAX = 160;
export const CONTENT_MAX = 600;
export const MIN_REPLY_CHARS_WITHOUT_TOOLS = 160;
export const TRANSCRIPT_MAX_CHARS = 6_000;

/** task_outcome stays VTID-03928's (tool outcomes) and the executor's; the model never writes it. */
export const EXTRACTABLE_CATEGORIES: ReadonlyArray<DevMemoryCategory> = ['decision', 'convention', 'incident', 'preference', 'gotcha'];

export function isTurnMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPERATOR_TURN_MEMORY_ENABLED === 'true';
}

export interface TurnTool { name: string; result: string }

/** Skip the model call for turns that cannot carry a durable fact. */
export function shouldExtract(userText: string, reply: string, tools: TurnTool[] = []): boolean {
  const u = (userText || '').trim();
  const r = (reply || '').trim();
  if (!u || !r) return false;
  if (tools.length > 0) return true;
  return r.length >= MIN_REPLY_CHARS_WITHOUT_TOOLS && u.length >= 12;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** English instruction to the model (CLAUDE.md §13b) — never user-facing. */
export function buildExtractionPrompt(input: { userText: string; reply: string; tools?: TurnTool[]; summary?: string | null }): string {
  const tools = (input.tools || []).map((t) => `- ${t.name}: ${clip(t.result.replace(/\s+/g, ' '), 400)}`).join('\n');
  const transcript = clip(`USER: ${input.userText}\n\nASSISTANT: ${input.reply}`, TRANSCRIPT_MAX_CHARS);
  return [
    'You maintain the long-term engineering memory of the Vitana platform (repo exafyltd/vitana-platform) for an internal operator console.',
    'From the conversation turn below, extract ONLY facts worth remembering in a later, unrelated session:',
    '- decision: a choice the platform owner or operator made ("route X through Y", "never do Z")',
    '- convention: a rule about how the codebase or process works that is not already obvious from the code',
    '- incident: something that broke, with the observed cause',
    '- preference: how the owner wants things done',
    '- gotcha: a non-obvious trap that cost time',
    'Do NOT record: transient status ("PR is open", "CI is running"), greetings, restatements of the question, anything already implied by the tool results being visible, or speculation.',
    `Return a JSON array (max ${MAX_ITEMS_PER_TURN} items, often []) of objects: {"category": one of ${EXTRACTABLE_CATEGORIES.join('|')}, "title": <= ${TITLE_MAX} chars, "content": <= ${CONTENT_MAX} chars stating the fact and why, "importance": 10-90, "vtid": "VTID-nnnnn" or null}.`,
    'Output the JSON array only. If nothing durable was said, output [].',
    input.summary ? `\nThread so far: ${clip(input.summary, 1_200)}` : '',
    tools ? `\nTool calls this turn:\n${tools}` : '',
    `\nTurn:\n${transcript}`,
  ].filter((l) => l !== '').join('\n');
}

export interface ExtractedMemory { category: DevMemoryCategory; title: string; content: string; importance: number; vtid?: string }

const VTID_RE = /\bVTID-\d{4,5}\b/;

/** Tolerant parse: finds the outermost array, drops malformed/unknown items, clamps, dedupes, caps. */
export function parseExtraction(text: string, vtidHint?: string): ExtractedMemory[] {
  const raw = (text || '').trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try { arr = JSON.parse(raw.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: ExtractedMemory[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const category = typeof o.category === 'string' ? (o.category.trim().toLowerCase() as DevMemoryCategory) : null;
    if (!category || !EXTRACTABLE_CATEGORIES.includes(category)) continue;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const content = typeof o.content === 'string' ? o.content.trim() : '';
    if (title.length < 8 || content.length < 20) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const imp = Number(o.importance);
    const importance = Number.isFinite(imp) ? Math.min(90, Math.max(10, Math.round(imp))) : 50;
    const vtidField = typeof o.vtid === 'string' ? o.vtid.match(VTID_RE)?.[0] : undefined;
    const vtid = vtidField || (`${title} ${content}`.match(VTID_RE)?.[0]) || vtidHint;
    out.push({ category, title: clip(title, TITLE_MAX), content: clip(content, CONTENT_MAX), importance, ...(vtid ? { vtid } : {}) });
    if (out.length >= MAX_ITEMS_PER_TURN) break;
  }
  return out;
}

export type Extractor = (prompt: string) => Promise<string | null>;
export type Writer = (input: WriteDevMemoryInput) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;

const routerExtractor: Extractor = async (prompt) => {
  const r = await callViaRouter('memory', prompt, { service: 'operator-turn-memory', maxTokens: 700 });
  if (!r.ok || !r.text) {
    console.warn(`${LOG_PREFIX} extraction failed via ${r.provider ?? 'router'}: ${r.error ?? 'empty'}`);
    return null;
  }
  return r.text;
};

export interface TurnMemoryInput {
  threadId: string;
  userText: string;
  reply: string;
  tools?: TurnTool[];
  summary?: string | null;
  vtidHint?: string;
  /** VTID-04223: who is recording. Defaults keep the Operator Console shape
   *  byte-for-byte; the agent executor passes its own provenance/tags/source
   *  so a later reader can tell a console fact from an executor-run fact. */
  provenance?: string;
  tags?: string[];
  source?: DevMemorySource;
}

/**
 * Extract durable facts from one turn and write them. Never throws.
 * Returns how many rows were written (0 when disabled, skipped, or failed).
 */
export async function extractAndRecordTurnMemory(
  input: TurnMemoryInput,
  opts: { extract?: Extractor; write?: Writer; env?: NodeJS.ProcessEnv } = {},
): Promise<{ written: number; skipped?: string }> {
  const env = opts.env || process.env;
  if (!isTurnMemoryEnabled(env)) return { written: 0, skipped: 'disabled' };
  if (!shouldExtract(input.userText, input.reply, input.tools)) return { written: 0, skipped: 'trivial_turn' };
  try {
    const text = await (opts.extract || routerExtractor)(buildExtractionPrompt(input));
    if (!text) return { written: 0, skipped: 'extractor_empty' };
    const items = parseExtraction(text, input.vtidHint);
    let written = 0;
    for (const m of items) {
      const r = await (opts.write || writeDevMemory)({
        repo: 'vitana-platform',
        category: m.category,
        title: m.title,
        content: `${m.content}\n\n(${input.provenance || `Operator Console thread ${input.threadId.slice(0, 8)}, extracted from the turn by VTID-04025.`})`,
        vtid: m.vtid,
        importance: m.importance,
        source: input.source || 'session',
        tags: [...(input.tags || ['operator-console', 'turn-extracted']), m.category],
      });
      if (r.ok) written += 1;
      else console.warn(`${LOG_PREFIX} write failed (${m.category} "${m.title.slice(0, 40)}"): ${r.error}`);
    }
    if (written > 0) console.log(`${LOG_PREFIX} thread ${input.threadId.slice(0, 8)}: ${written} memory row(s) written`);
    return { written };
  } catch (err) {
    console.warn(`${LOG_PREFIX} extractAndRecordTurnMemory error:`, err instanceof Error ? err.message : err);
    return { written: 0, skipped: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Executor outcomes
// ---------------------------------------------------------------------------

export interface ExecutionOutcomeInput {
  executionId: string;
  ok: boolean;
  prUrl?: string;
  branch?: string;
  error?: string;
  vtid?: string;
  executor?: string;
  /**
   * The plan's/diff's concrete changed files, when the caller has them
   * cheaply on hand. Optional and additive -- an omitted list just means
   * this row won't surface via recallDevMemoryByFiles, exactly as before
   * this field existed. Wiring a real file list into the two call sites
   * in dev-autopilot-execute.ts is a deliberate follow-up, not done here
   * (it needs its own plan/diff lookup in a function this repo's own
   * change log flags as high-churn and cancellation-sensitive).
   */
  filePaths?: string[];
}

export function buildExecutionOutcomeMemory(input: ExecutionOutcomeInput): WriteDevMemoryInput {
  const exec8 = input.executionId.slice(0, 8);
  const who = input.executor ? `${input.executor} executor` : 'executor';
  const filePaths = input.filePaths ?? [];
  if (input.ok) {
    return {
      repo: 'vitana-platform',
      category: 'task_outcome',
      title: clip(`Dev Autopilot ${exec8}${input.vtid ? ` (${input.vtid})` : ''} opened a PR`, TITLE_MAX),
      content: clip(`The ${who} run ${exec8}${input.vtid ? ` for ${input.vtid}` : ''} opened ${input.prUrl || 'a PR'}${input.branch ? ` from branch ${input.branch}` : ''}. CI and merge are tracked by the watcher; see dev_autopilot_executions.`, CONTENT_MAX),
      vtid: input.vtid,
      importance: 40,
      source: 'autopilot',
      tags: ['dev-autopilot', 'execution', 'pr_opened'],
      filePaths,
      stage: 'worker',
    };
  }
  const reason = (input.error || 'unknown').replace(/\s+/g, ' ').trim();
  return {
    repo: 'vitana-platform',
    category: 'gotcha',
    title: clip(`Dev Autopilot ${exec8}${input.vtid ? ` (${input.vtid})` : ''} failed: ${reason.slice(0, 90)}`, TITLE_MAX),
    content: clip(`The ${who} run ${exec8}${input.vtid ? ` for ${input.vtid}` : ''} failed. Reason: ${reason}`, CONTENT_MAX),
    vtid: input.vtid,
    importance: 55,
    source: 'autopilot',
    tags: ['dev-autopilot', 'execution', 'failed'],
    filePaths,
    stage: 'worker',
  };
}

/** Fire-and-forget from applyExecutionResult. Never throws. */
export async function recordExecutionOutcomeMemory(
  input: ExecutionOutcomeInput,
  opts: { write?: Writer; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  if (!isTurnMemoryEnabled(opts.env || process.env)) return false;
  try {
    const r = await (opts.write || writeDevMemory)(buildExecutionOutcomeMemory(input));
    if (!r.ok) console.warn(`${LOG_PREFIX} execution outcome write failed for ${input.executionId.slice(0, 8)}: ${r.error}`);
    return r.ok;
  } catch (err) {
    console.warn(`${LOG_PREFIX} recordExecutionOutcomeMemory error:`, err instanceof Error ? err.message : err);
    return false;
  }
}
