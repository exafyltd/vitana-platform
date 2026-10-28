/**
 * RepoWise + Graphify read-only CLI bridge (VTID-04116).
 *
 * Backs the Operator Console's `dev_repowise` / `dev_graphify` tools.
 * CLAUDE.md's "Mandatory Codebase Intelligence Workflow" has told every
 * session to query RepoWise and Graphify since it was written, but neither
 * tool was ever installed anywhere a session or the Operator Console could
 * reach — confirmed directly (`pip install repowise`, `uv tool install
 * graphifyy` both succeed, both are real published packages) and already
 * flagged once in this file's own CHANGE LOG (2026-09-17, VTID-04002 gap
 * analysis: "RepoWise/Graphify exist in neither repo nor the container, so
 * CLAUDE.md's mandatory index workflow is currently unsatisfiable for the
 * console and for sessions"). This module is the console half of closing
 * that gap; `.claude/hooks/session-start-codeintel-setup.sh` in both repos
 * is the per-session half.
 *
 * Same posture as `aws-cloudwatch-logs-readonly.ts`, deliberately: a
 * separate module, read-only by construction, bounded output, an
 * `execFile` (never a shell) over an allowlisted, fixed argv per command so
 * no operator input ever reaches a shell or an arbitrary CLI flag. Neither
 * binary is installed in the gateway's own runtime image yet (see the
 * Dockerfile follow-up this VTID flags, not fixed here) — `isConfigured()`
 * reports `not_configured` exactly like `BEDROCK_ROLE_ARN` unset does
 * (CLAUDE.md IF-THEN 31's contract), so this ships inert until an operator
 * bakes the CLIs (and a built index) into the image. Gated by
 * `OPERATOR_CODEINTEL_ENABLED`.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const CODEINTEL_TIMEOUT_MS = 20_000;
export const CODEINTEL_OUTPUT_MAX_CHARS = 12_000;

function boundOutput(s: string): { text: string; truncated: boolean } {
  const trimmed = (s || '').trim();
  if (trimmed.length <= CODEINTEL_OUTPUT_MAX_CHARS) return { text: trimmed, truncated: false };
  return { text: `${trimmed.slice(0, CODEINTEL_OUTPUT_MAX_CHARS)}…`, truncated: true };
}

export interface CodeintelResult {
  ok: boolean;
  command: string;
  output: string;
  truncated: boolean;
  error?: string;
}

async function runBinary(bin: string, args: string[], cwd: string): Promise<CodeintelResult> {
  const command = `${bin} ${args.join(' ')}`;
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      timeout: CODEINTEL_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH: `${process.env.HOME || '/root'}/.local/bin:${process.env.PATH || ''}` },
    });
    const { text, truncated } = boundOutput(stdout || stderr || '');
    return { ok: true, command, output: text, truncated };
  } catch (err: any) {
    // ENOENT = binary not installed in this runtime — the expected shape
    // until the Dockerfile follow-up ships; every other failure (bad
    // query, index missing, timeout) is returned verbatim, never swallowed.
    if (err?.code === 'ENOENT') {
      return { ok: false, command, output: '', truncated: false, error: `not_configured: "${bin}" is not installed in this runtime` };
    }
    const raw = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n');
    const { text } = boundOutput(raw || String(err));
    return { ok: false, command, output: '', truncated: false, error: text || 'unknown codeintel CLI failure' };
  }
}

export type RepowiseCommand = 'ask' | 'search' | 'context' | 'risk' | 'health' | 'why' | 'status';
const REPOWISE_COMMANDS: RepowiseCommand[] = ['ask', 'search', 'context', 'risk', 'health', 'why', 'status'];

export function isRepowiseCommand(v: string): v is RepowiseCommand {
  return REPOWISE_COMMANDS.includes(v as RepowiseCommand);
}

/**
 * Runs one allowlisted `repowise` subcommand against the given repo
 * checkout. `argument` is the free-text payload for commands that take one
 * (a question for `ask`, a query for `search`, a path for `context`/`risk`)
 * — omitted for `health`/`status`, which take none.
 */
export async function runRepowise(command: RepowiseCommand, argument: string | undefined, repoDir: string): Promise<CodeintelResult> {
  const args: string[] = [command];
  if (argument && argument.trim()) args.push(argument.trim());
  // VTID-04125: `--no-prose` was unconditionally appended here, but it is
  // not a real option on ANY of the 7 allowlisted subcommands (confirmed
  // live: `repowise ask/search/context/risk/health/why/status --help`
  // lists none of them with a `--no-prose` flag — it exists only on
  // `init`, which the session-start hook already uses it on separately).
  // Every real `dev_repowise` invocation was therefore failing outright
  // with a CLI usage error ("No such option") before this fix, regardless
  // of whether an LLM provider was configured for prose synthesis.
  return runBinary('repowise', args, repoDir);
}

export type GraphifyCommand = 'query' | 'path' | 'explain';
const GRAPHIFY_COMMANDS: GraphifyCommand[] = ['query', 'path', 'explain'];

export function isGraphifyCommand(v: string): v is GraphifyCommand {
  return GRAPHIFY_COMMANDS.includes(v as GraphifyCommand);
}

/**
 * Runs one allowlisted `graphify` subcommand against `graphify-out/graph.json`
 * in the given repo checkout. `query`/`explain` take one free-text argument;
 * `path` takes two (source and target node names), space-separated in
 * `argument` and split on the first space.
 */
export async function runGraphify(command: GraphifyCommand, argument: string | undefined, repoDir: string): Promise<CodeintelResult> {
  const arg = (argument || '').trim();
  if (command === 'path') {
    const parts = arg.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return { ok: false, command: `graphify path`, output: '', truncated: false, error: 'path requires two node names, e.g. "UserService DatabasePool"' };
    }
    return runBinary('graphify', ['path', parts[0], parts.slice(1).join(' ')], repoDir);
  }
  if (!arg) {
    return { ok: false, command: `graphify ${command}`, output: '', truncated: false, error: `${command} requires a query/component argument` };
  }
  return runBinary('graphify', [command, arg], repoDir);
}

export const ALLOWED_CODEINTEL_REPOS: Record<string, string> = {
  'exafyltd/vitana-platform': process.env.CODEINTEL_PLATFORM_REPO_DIR || '/app',
  'exafyltd/vitana-v1': process.env.CODEINTEL_V1_REPO_DIR || '/app-vitana-v1',
};

export function resolveCodeintelRepoDir(repo: string | undefined): string | null {
  const key = (repo || 'exafyltd/vitana-platform').trim();
  return ALLOWED_CODEINTEL_REPOS[key] || null;
}
