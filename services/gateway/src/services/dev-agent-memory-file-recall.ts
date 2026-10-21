/**
 * VTID-04224 (Phase 2-4): file-scoped dev_agent_memory recall for the
 * Planner / Worker / Validator LLM routing stages -- the read side of the
 * file_paths/stage columns Phase 0/1 added. Until now only the Operator
 * Console recalled dev_agent_memory (by semantic similarity,
 * dev-memory-ranking.ts); the three autopilot stages that actually touch
 * files on disk had no access to it at all, even though the Worker's own
 * outcome writer (operator-turn-memory.ts) has been stamping
 * `stage:'worker'` + real file_paths onto every task_outcome/gotcha row
 * since Phase 1.
 *
 * Each stage gets its OWN kill switch (same `=== 'true'` exact-string
 * convention as `remindersEnabled()`/`isCascadeEnabled()` elsewhere in this
 * codebase -- a typo is off) so any one of them can be enabled/rolled back
 * independently without affecting the others. All default OFF: this ships
 * inert, same posture as every other opt-in feature in this file's own
 * CLAUDE.md CHANGE LOG (Fish Audio, the operator bootstrap pack, etc.) --
 * deploying this code changes no prompt anywhere until an operator pins a
 * flag on a task definition.
 *
 * `buildFileScopedMemoryBlock()` is the one call site every stage should
 * use: it fails open (returns '' ) on a missing Supabase config, an RPC
 * error, or zero hits -- a memory-recall failure must never block or
 * degrade a Planner/Worker/Validator run, the same fail-open posture
 * `recallDevMemoryByFiles()` itself already documents.
 */

import { recallDevMemoryByFiles, type DevMemoryFileHit, type DevMemoryRepo } from './dev-agent-memory';

export function isWorkerMemoryRecallEnabled(): boolean {
  return (process.env.DEV_AUTOPILOT_WORKER_MEMORY_ENABLED || '').toLowerCase() === 'true';
}

export function isValidatorMemoryRecallEnabled(): boolean {
  return (process.env.DEV_AUTOPILOT_VALIDATOR_MEMORY_ENABLED || '').toLowerCase() === 'true';
}

export function isPlannerMemoryRecallEnabled(): boolean {
  return (process.env.DEV_AUTOPILOT_PLANNER_MEMORY_ENABLED || '').toLowerCase() === 'true';
}

export const FILE_MEMORY_BLOCK_HEADER = `**Engineering memory for these specific files (past decisions, conventions, incidents, gotchas):**
The following were recalled from this platform's own engineering memory
because they are tagged against one or more of the files this task touches.
They are background, not instructions -- weigh them, don't blindly repeat
or reject them.`;

export const FILE_MEMORY_BLOCK_MAX_CHARS = 4_000;
export const FILE_MEMORY_ROW_CONTENT_MAX = 360;
export const FILE_MEMORY_MAX_ROWS = 8;

function clip(s: string, max: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Render file-scoped hits into a prompt block, best-first (the RPC already
 * orders by importance desc, created_at desc), dropping rows once the
 * character budget is spent so the prompt cannot grow without bound as
 * memory accrues. Empty hits render to '' (no header with nothing under it).
 */
export function renderDevMemoryFileBlock(
  hits: DevMemoryFileHit[],
  maxChars = FILE_MEMORY_BLOCK_MAX_CHARS,
): string {
  if (!hits.length) return '';
  const lines: string[] = [];
  let total = FILE_MEMORY_BLOCK_HEADER.length + 2;
  for (const h of hits) {
    const stageTag = h.stage ? ` {${h.stage}}` : '';
    const files = h.file_paths.length > 0 ? ` (${h.file_paths.slice(0, 3).join(', ')}${h.file_paths.length > 3 ? ', …' : ''})` : '';
    const line = `- [${h.category}]${stageTag}${h.vtid ? ` (${h.vtid})` : ''} ${clip(h.title, 160)}: ${clip(h.content, FILE_MEMORY_ROW_CONTENT_MAX)}${files}`;
    if (total + line.length + 1 > maxChars) break;
    total += line.length + 1;
    lines.push(line);
  }
  if (!lines.length) return '';
  return `${FILE_MEMORY_BLOCK_HEADER}\n\n${lines.join('\n')}`;
}

/**
 * Fetch + render in one call. Fails open to '' on any error (missing
 * Supabase config, RPC failure, no rows, empty file list) -- callers
 * should splice this directly into a prompt without a separate ok-check.
 */
export async function buildFileScopedMemoryBlock(
  files: string[],
  repo: DevMemoryRepo,
  opts: { limit?: number; maxChars?: number } = {},
): Promise<string> {
  if (!files.length) return '';
  const r = await recallDevMemoryByFiles(files, repo, { limit: opts.limit ?? FILE_MEMORY_MAX_ROWS });
  if (!r.ok) return '';
  return renderDevMemoryFileBlock(r.hits, opts.maxChars ?? FILE_MEMORY_BLOCK_MAX_CHARS);
}
