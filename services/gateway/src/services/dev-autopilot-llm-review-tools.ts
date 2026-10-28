/**
 * VTID-04231: the validator's tool set — scoped to what a pre-merge reviewer
 * needs and nothing else (build plan item 4, docs/AGENT-REGISTRY.md §5).
 *
 * Until now `runLlmMergeReview` handed the `validator` stage one prompt
 * holding a bounded diff bundle and asked for a verdict: it could not read
 * the rest of a changed file (a diff hunk is 3 lines of context), could not
 * see what CI actually said about the head commit, and had no idea whether
 * the file it was judging is a hotspot with a bus factor of one. Three
 * read-only tools close that, all pinned to the PR's HEAD sha so the model
 * reviews exactly what would merge:
 *
 *   read_file(path, start_line?, end_line?)  — the file at the PR head, via
 *     the GitHub contents API (`github-service.getFileContents`), bounded.
 *   ci_evidence()                             — the head commit's check-runs
 *     (name / status / conclusion) plus the bounded job-log excerpt of any
 *     failing one (`collectCiFailureEvidence`, VTID-04005).
 *   dev_get_risk(path)                        — the VTID-04229 codebase index's
 *     change-risk facts for one file (churn, bug fixes, owner %, hotspot,
 *     import fan-in, co-change partners).
 *
 * No write, no shell, no arbitrary URL. Every tool returns an honest error
 * string on failure (the loop feeds it back to the model) and never throws.
 */

import { getFileContents, getCheckRuns } from './github-service';
import { collectCiFailureEvidence, renderCiEvidence } from './dev-autopilot-ci-logs';
import { loadCodeIndex, runCodeIndexTool, CODE_INDEX_TOOL_SCHEMAS, type CodeIndexBundle } from './codeintel-index';
import type { LLMRouterTool } from './llm-router';
import type { StageToolOutcome } from './llm-stage-tool-loop';

export const VALIDATOR_TOOL_NAMES = ['read_file', 'ci_evidence', 'dev_get_risk'] as const;
export type ValidatorToolName = (typeof VALIDATOR_TOOL_NAMES)[number];
export const VALIDATOR_READ_FILE_MAX_CHARS = 20_000;
export const VALIDATOR_READ_FILE_MAX_LINES = 400;

export function validatorRouterTools(): LLMRouterTool[] {
  return [
    {
      name: 'read_file',
      description: 'Read a file at the PR head commit (repo-root-relative path). Returns numbered lines; use start_line/end_line to window a large file. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-root-relative path, e.g. services/gateway/src/services/dev-autopilot-watcher.ts' },
          start_line: { type: 'integer', description: '1-based first line (default 1)' },
          end_line: { type: 'integer', description: `1-based last line (default start_line + ${VALIDATOR_READ_FILE_MAX_LINES - 1})` },
        },
        required: ['path'],
      },
    },
    {
      name: 'ci_evidence',
      description: 'The check-runs on the PR head commit (name, status, conclusion) and a bounded log excerpt for every failing one. No arguments. Read-only.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'dev_get_risk',
      description: CODE_INDEX_TOOL_SCHEMAS.dev_get_risk.description,
      inputSchema: { type: 'object', properties: { path: CODE_INDEX_TOOL_SCHEMAS.dev_get_risk.properties.path }, required: ['path'] },
    },
  ];
}

export interface ValidatorToolContext {
  /** owner/name */
  repo: string;
  headSha: string;
  /** Test seams. */
  loadIndex?: typeof loadCodeIndex;
  collectEvidence?: typeof collectCiFailureEvidence;
}

function windowLines(content: string, startArg: unknown, endArg: unknown): string {
  const lines = content.split('\n');
  const start = Math.max(1, Number.isFinite(Number(startArg)) && Number(startArg) > 0 ? Math.floor(Number(startArg)) : 1);
  const endRaw = Number.isFinite(Number(endArg)) && Number(endArg) > 0 ? Math.floor(Number(endArg)) : start + VALIDATOR_READ_FILE_MAX_LINES - 1;
  const end = Math.min(lines.length, endRaw, start + VALIDATOR_READ_FILE_MAX_LINES - 1);
  const out: string[] = [];
  for (let i = start; i <= end; i++) out.push(`${i}: ${lines[i - 1]}`);
  let text = out.join('\n');
  if (text.length > VALIDATOR_READ_FILE_MAX_CHARS) text = `${text.slice(0, VALIDATOR_READ_FILE_MAX_CHARS)}\n…[truncated]`;
  const tail = end < lines.length ? `\n…[${lines.length - end} more line(s); the file has ${lines.length} lines]` : '';
  return `${text}${tail}`;
}

/** Builds the validator's `execute` for one PR. Each call is independent and never throws. */
export function createValidatorToolExecutor(ctx: ValidatorToolContext): (name: string, args: Record<string, unknown>) => Promise<StageToolOutcome> {
  const [owner, name] = ctx.repo.includes('/') ? ctx.repo.split('/', 2) : ['exafyltd', ctx.repo];
  let bundlePromise: Promise<CodeIndexBundle> | null = null;
  const bundle = () => {
    if (!bundlePromise) bundlePromise = (ctx.loadIndex || loadCodeIndex)(ctx.repo).then((l) => l.bundle);
    return bundlePromise;
  };

  return async (tool, args) => {
    try {
      switch (tool) {
        case 'read_file': {
          const path = typeof args.path === 'string' ? args.path.trim() : '';
          if (!path) return { result: 'read_file: path is required', isError: true };
          const got = await getFileContents(ctx.repo, path, ctx.headSha);
          if (got.type === 'dir') {
            return { result: `${path} is a directory at ${ctx.headSha.slice(0, 8)}:\n${got.entries.map((e: { type: string; path: string }) => `${e.type} ${e.path}`).join('\n')}` };
          }
          return { result: `${got.path} @ ${ctx.headSha.slice(0, 8)}\n${windowLines(got.content, args.start_line, args.end_line)}` };
        }
        case 'ci_evidence': {
          const runs = await getCheckRuns(ctx.repo, ctx.headSha);
          const list = (runs?.check_runs || []) as Array<{ name: string; status?: string; conclusion?: string | null }>;
          if (list.length === 0) return { result: `no check-runs reported yet on ${ctx.headSha.slice(0, 8)}` };
          const lines = list.map((c) => `- ${c.name}: ${c.status || 'unknown'}${c.conclusion ? ` / ${c.conclusion}` : ''}`);
          const failedNames = list.filter((c) => c.conclusion && !['success', 'neutral', 'skipped'].includes(c.conclusion)).map((c) => c.name);
          let evidence = '';
          if (failedNames.length > 0) {
            const excerpts = await (ctx.collectEvidence || collectCiFailureEvidence)({ owner, repo: name, headSha: ctx.headSha, failedNames });
            evidence = renderCiEvidence(excerpts, undefined, failedNames.length);
          }
          return { result: `check-runs on ${ctx.headSha.slice(0, 8)} (${list.length}, ${failedNames.length} failing):\n${lines.join('\n')}${evidence ? `\n\n${evidence}` : ''}` };
        }
        case 'dev_get_risk': {
          const path = typeof args.path === 'string' ? args.path.trim() : '';
          if (!path) return { result: 'dev_get_risk: path is required', isError: true };
          const b = await bundle();
          const out = runCodeIndexTool('dev_get_risk', { path }, b);
          return { result: out.text, isError: !out.ok };
        }
        default:
          return { result: `unknown tool: ${tool} (validator tools: ${VALIDATOR_TOOL_NAMES.join(', ')})`, isError: true };
      }
    } catch (err) {
      return { result: `${tool} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  };
}
