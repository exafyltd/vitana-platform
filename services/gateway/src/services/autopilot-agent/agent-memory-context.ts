/**
 * VTID-04223: engineering memory for the agent executor.
 *
 * Until this module the executor started every run knowing only its plan,
 * the CLAUDE.md Part 1 excerpt from its clone and the static conventions
 * block (docs/AGENT-REGISTRY.md row 2) — no service map, no open PRs, no
 * `dev_agent_memory`, and no record of what attempt N-1 on the same
 * finding tried. This module assembles, at run start, the three memory
 * sources a Claude Code session has, and at run end writes the durable
 * facts the run surfaced:
 *
 *   IN  (a) the W4a session bootstrap pack (operator-bootstrap-pack.ts,
 *           REUSED — same fetchers, same renderers; the governance-rules
 *           section is dropped because the runner already carries CLAUDE.md
 *           Part 1 from the clone, and the tool catalog is the executor's
 *           own so it is not rendered twice);
 *       (b) top-10 category-diverse `dev_agent_memory` recall
 *           (dev-memory-ranking.ts, VTID-04027) against the task text + VTID;
 *       (c) the finding's prior `agent_runs[]` (dev_autopilot_outcomes
 *           metadata, VTID-04017) so a retry knows what attempt N-1 did.
 *   OUT (d) gotcha/decision/convention/incident rows extracted from the run's
 *           transcript by the same `memory`-stage extractor the Operator
 *           Console uses (operator-turn-memory.ts, VTID-04025). The
 *           task_outcome / failure gotcha row is NOT written here — the
 *           gateway's applyExecutionResult already writes it.
 *
 * Every source is bounded and timed out and fails open to an empty block:
 * a memory outage degrades the run to exactly what it was before this VTID.
 * The whole injected block is capped at AGENT_MEMORY_TOTAL_MAX_CHARS so it
 * cannot crowd the loop's own history budget (VTID-04112).
 */

import { supa, type SupaConfig } from '../dev-autopilot-execute';
import { recallDevMemory, type DevMemoryHit } from '../dev-agent-memory';
import { RECALL_CANDIDATES, diversifyRecallHits, renderDevMemoryBlock } from '../dev-memory-ranking';
import {
  BOOTSTRAP_RULES_SECTION_TITLE, assembleBootstrapPack, buildBootstrapSections, defaultBootstrapDeps, withTimeout,
  type BootstrapDeps, type PackSection,
} from '../operator-bootstrap-pack';
import { extractAndRecordTurnMemory, type Extractor, type Writer } from '../operator-turn-memory';
import type { AgentRunUsage } from '../dev-autopilot-outcomes';
import type { LLMRouterMessage } from '../llm-router';
import type { FinishArgs } from './agent-tools';

const LOG_PREFIX = '[autopilot-agent:memory]';

export const AGENT_BOOTSTRAP_MAX_CHARS = 20_000;
export const AGENT_RECALL_MAX_CHARS = 6_000;
export const AGENT_PRIOR_RUNS_MAX = 5;
export const AGENT_PRIOR_RUNS_MAX_CHARS = 3_000;
export const AGENT_MEMORY_TOTAL_MAX_CHARS = 30_000;
export const AGENT_MEMORY_SOURCE_TIMEOUT_MS = 8_000;
export const AGENT_RECALL_QUERY_MAX_CHARS = 1_500;
export const AGENT_TRANSCRIPT_MAX_CHARS = 6_000;
export const AGENT_BOOTSTRAP_HEADER = '**Session bootstrap pack (VTID-04018, reused by the agent executor — VTID-04223). Orientation only: use read_file / search_text / find_files for anything specific.**';
export const AGENT_MEMORY_HEADER = '## Engineering memory for this run (read before acting; bounded, may be partial)';

/** Default ON: the executor task carries no OPERATOR_* flags, and every
 *  source below fails open, so the safe default is to try. `false` (exact
 *  string) turns the whole block off, in and out. */
export function isAgentMemoryContextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AGENT_MEMORY_CONTEXT_ENABLED || '').trim().toLowerCase() !== 'false';
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---------------------------------------------------------------------------
// Pure renderers
// ---------------------------------------------------------------------------

/** The text recall is embedded against: VTID + the plan/request + the prior failure. */
export function buildAgentRecallQuery(input: { vtid: string; planMarkdown: string; priorFailure?: string | null }): string {
  const parts = [input.vtid, clip((input.planMarkdown || '').replace(/\s+/g, ' ').trim(), AGENT_RECALL_QUERY_MAX_CHARS)];
  if (input.priorFailure) parts.push(clip(input.priorFailure.replace(/\s+/g, ' ').trim(), 400));
  return parts.filter(Boolean).join('\n');
}

export type PriorAgentRun = Partial<AgentRunUsage> & { execution_id?: string };

/** Newest first, the current execution excluded, capped in rows and chars. */
export function renderPriorAgentRuns(runs: unknown, currentExecutionId: string, max = AGENT_PRIOR_RUNS_MAX, maxChars = AGENT_PRIOR_RUNS_MAX_CHARS): string {
  if (!Array.isArray(runs)) return '';
  const rows = (runs as PriorAgentRun[])
    .filter((r) => r && typeof r === 'object' && r.execution_id && r.execution_id !== currentExecutionId)
    .slice(-max)
    .reverse();
  if (rows.length === 0) return '';
  const lines = rows.map((r) => {
    const id = String(r.execution_id).slice(0, 8);
    const bits = [
      `outcome=${r.outcome || '?'}`,
      r.fix_mode ? 'fix_mode' : '',
      r.turns != null ? `turns=${r.turns}` : '',
      r.fix_rounds != null ? `fix_rounds=${r.fix_rounds}` : '',
      r.model ? `model=${r.model}` : '',
      r.cost_usd != null ? `cost=$${Number(r.cost_usd).toFixed(4)}` : '',
      r.recorded_at ? `at=${String(r.recorded_at).slice(0, 19)}` : '',
    ].filter(Boolean).join(' ');
    const err = r.error ? ` — error: ${clip(String(r.error).replace(/\s+/g, ' '), 300)}` : '';
    return `- ${id}: ${bits}${err}`;
  });
  const body = clip(lines.join('\n'), maxChars);
  return `### Prior attempts on this finding (newest first) — do not repeat what already failed\n${body}`;
}

export interface AgentMemoryParts {
  bootstrap: string;
  recall: string;
  priorRuns: string;
}

export function renderAgentMemoryContext(parts: AgentMemoryParts, maxChars = AGENT_MEMORY_TOTAL_MAX_CHARS): string {
  const sections = [parts.priorRuns, parts.recall, parts.bootstrap].map((s) => (s || '').trim()).filter(Boolean);
  if (sections.length === 0) return '';
  // Prior runs and recall are the task-specific, cheapest signals — they are
  // placed first so a cap trims the (largest, most generic) bootstrap tail.
  return clip([AGENT_MEMORY_HEADER, ...sections].join('\n\n'), maxChars);
}

/** The loop transcript, bounded, for the end-of-run extractor. */
export function renderAgentTranscript(history: LLMRouterMessage[], maxChars = AGENT_TRANSCRIPT_MAX_CHARS): string {
  const lines: string[] = [];
  for (const m of history) {
    if ('toolCalls' in m && m.toolCalls) {
      lines.push(`ASSISTANT→tools: ${m.toolCalls.map((c) => `${c.name}(${clip(JSON.stringify(c.arguments ?? {}), 160)})`).join('; ')}`);
    } else if ('toolResults' in m && m.toolResults) {
      lines.push(`TOOLS: ${m.toolResults.map((r) => `${r.name}${r.isError ? ' ERROR' : ''}: ${clip(r.result.replace(/\s+/g, ' '), 200)}`).join(' | ')}`);
    } else if ('content' in m && typeof m.content === 'string') {
      lines.push(`${m.role.toUpperCase()}: ${clip(m.content.replace(/\s+/g, ' '), 600)}`);
    }
  }
  // Keep the END of the transcript — that is where the run's lessons are.
  const text = lines.join('\n');
  return text.length > maxChars ? `…${text.slice(text.length - maxChars)}` : text;
}

// ---------------------------------------------------------------------------
// Assembly (fail-open per source)
// ---------------------------------------------------------------------------

export interface AgentMemoryDeps {
  bootstrapDeps?: Partial<BootstrapDeps>;
  buildSections?: (deps: BootstrapDeps) => Promise<PackSection[]>;
  recall?: (query: string) => Promise<{ ok: true; hits: DevMemoryHit[] } | { ok: false; error: string }>;
  readPriorRuns?: (findingId: string) => Promise<unknown>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface AgentMemoryStats {
  enabled: boolean;
  bootstrap_chars: number;
  bootstrap_sections: number;
  recall_rows: number;
  recall_titles: string[];
  recall_chars: number;
  prior_runs: number;
  total_chars: number;
  errors: string[];
}

export interface AgentMemoryContextInput {
  executionId: string;
  findingId: string;
  vtid: string;
  planMarkdown: string;
  priorFailure?: string | null;
}

/** Reads the finding's latest outcome row's `metadata.agent_runs[]` (VTID-04017). */
export async function readPriorAgentRuns(s: SupaConfig, findingId: string): Promise<unknown> {
  const r = await supa<Array<{ metadata: unknown }>>(
    s, `/rest/v1/dev_autopilot_outcomes?finding_id=eq.${encodeURIComponent(findingId)}&order=created_at.desc&limit=1&select=metadata`,
  );
  if (!r.ok) throw new Error(r.error || `dev_autopilot_outcomes http_${r.status}`);
  const meta = r.data?.[0]?.metadata;
  return meta && typeof meta === 'object' ? (meta as { agent_runs?: unknown }).agent_runs : undefined;
}

export async function buildAgentMemoryContext(
  input: AgentMemoryContextInput,
  s: SupaConfig | null,
  deps: AgentMemoryDeps = {},
): Promise<{ text: string; stats: AgentMemoryStats }> {
  const env = deps.env || process.env;
  const stats: AgentMemoryStats = {
    enabled: isAgentMemoryContextEnabled(env), bootstrap_chars: 0, bootstrap_sections: 0, recall_rows: 0, recall_titles: [], recall_chars: 0, prior_runs: 0, total_chars: 0, errors: [],
  };
  if (!stats.enabled) return { text: '', stats };
  const timeoutMs = deps.timeoutMs ?? AGENT_MEMORY_SOURCE_TIMEOUT_MS;
  const nowIso = (deps.now ? deps.now() : new Date()).toISOString();

  const bootstrapP = (async () => {
    const base = deps.bootstrapDeps ? { ...defaultBootstrapDeps(), ...deps.bootstrapDeps, env } : { ...defaultBootstrapDeps(), env };
    const sections = await withTimeout((deps.buildSections || buildBootstrapSections)(base), timeoutMs, 'bootstrap pack');
    const kept = sections.filter((sec) => sec.title !== BOOTSTRAP_RULES_SECTION_TITLE);
    stats.bootstrap_sections = kept.filter((sec) => sec.body && !sec.error).length;
    // The pack's own header names the Operator Console's tools; the executor
    // has its own (read_file / search_text / find_files), so the header is
    // rewritten rather than left pointing at tools this agent cannot call.
    const text = assembleBootstrapPack(kept, nowIso, AGENT_BOOTSTRAP_MAX_CHARS)
      .replace(/^\*\*Session bootstrap pack[^\n]*\*\*/m, AGENT_BOOTSTRAP_HEADER);
    stats.bootstrap_chars = text.length;
    return text;
  })().catch((err: unknown) => { stats.errors.push(`bootstrap: ${msg(err)}`); return ''; });

  const recallP = (async () => {
    const query = buildAgentRecallQuery(input);
    const r = await withTimeout((deps.recall || ((q: string) => recallDevMemory(q, 'vitana-platform', { limit: RECALL_CANDIDATES })))(query), timeoutMs, 'memory recall');
    if (!r.ok) throw new Error(r.error);
    const hits = diversifyRecallHits(r.hits);
    stats.recall_rows = hits.length;
    stats.recall_titles = hits.map((h) => h.title.slice(0, 80));
    const block = hits.length ? renderDevMemoryBlock(hits, AGENT_RECALL_MAX_CHARS) : '';
    stats.recall_chars = block.length;
    return block;
  })().catch((err: unknown) => { stats.errors.push(`recall: ${msg(err)}`); return ''; });

  const priorP = (async () => {
    const reader = deps.readPriorRuns || (s ? (id: string) => readPriorAgentRuns(s, id) : null);
    if (!reader) return '';
    const runs = await withTimeout(reader(input.findingId), timeoutMs, 'prior agent runs');
    const text = renderPriorAgentRuns(runs, input.executionId);
    stats.prior_runs = Array.isArray(runs) ? (runs as PriorAgentRun[]).filter((r) => r?.execution_id && r.execution_id !== input.executionId).length : 0;
    return text;
  })().catch((err: unknown) => { stats.errors.push(`prior_runs: ${msg(err)}`); return ''; });

  const [bootstrap, recall, priorRuns] = await Promise.all([bootstrapP, recallP, priorP]);
  const text = renderAgentMemoryContext({ bootstrap, recall, priorRuns });
  stats.total_chars = text.length;
  return { text, stats };
}

// ---------------------------------------------------------------------------
// End of run: durable facts out
// ---------------------------------------------------------------------------

export interface AgentRunMemoryInput {
  executionId: string;
  vtid: string | null;
  taskText: string;
  history: LLMRouterMessage[];
  finished: FinishArgs | null;
  outcome: string;
  error?: string | null;
}

/**
 * Extracts ≤3 durable facts from the run's transcript through the `memory`
 * routing stage and writes them to `dev_agent_memory` with executor
 * provenance. Never throws; returns rows written. Disabled entirely by
 * AGENT_MEMORY_CONTEXT_ENABLED=false. Deliberately forces the console's
 * OPERATOR_TURN_MEMORY_ENABLED gate open for THIS call only — the executor
 * task carries no OPERATOR_* flags, and this module's own flag is the
 * executor's switch.
 */
export async function recordAgentRunMemory(
  input: AgentRunMemoryInput,
  opts: { env?: NodeJS.ProcessEnv; extract?: Extractor; write?: Writer } = {},
): Promise<{ written: number; skipped?: string }> {
  const env = opts.env || process.env;
  if (!isAgentMemoryContextEnabled(env)) return { written: 0, skipped: 'disabled' };
  if (!input.history || input.history.length === 0) return { written: 0, skipped: 'no_transcript' };
  try {
    const short = input.executionId.slice(0, 8);
    const transcript = renderAgentTranscript(input.history);
    const reply = [
      `Run outcome: ${input.outcome}${input.error ? ` — ${clip(input.error, 400)}` : ''}`,
      input.finished ? `Agent summary: ${clip(input.finished.summary, 1_200)}` : '',
      `Transcript (tail):\n${transcript}`,
    ].filter(Boolean).join('\n');
    const tools = input.history
      .flatMap((m) => ('toolResults' in m && m.toolResults ? m.toolResults : []))
      .filter((r) => r.isError)
      .slice(-6)
      .map((r) => ({ name: r.name, result: clip(r.result, 400) }));
    return await extractAndRecordTurnMemory(
      {
        threadId: `agent-exec-${input.executionId}`,
        userText: clip(input.taskText, 2_000),
        reply,
        tools,
        vtidHint: input.vtid || undefined,
        provenance: `Dev Autopilot agent executor run ${short}${input.vtid ? ` for ${input.vtid}` : ''}, extracted from the run transcript by VTID-04223.`,
        tags: ['dev-autopilot', 'agent-executor', 'run-extracted'],
        source: 'autopilot',
      },
      { env: { ...env, OPERATOR_TURN_MEMORY_ENABLED: 'true' }, extract: opts.extract, write: opts.write },
    );
  } catch (err) {
    console.warn(`${LOG_PREFIX} recordAgentRunMemory error:`, msg(err));
    return { written: 0, skipped: 'error' };
  }
}

function msg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
