/**
 * VTID-04006: the agent executor's tool surface.
 *
 * Every tool is jailed to the workspace root (a fresh shallow clone made for
 * this execution and deleted afterwards). There is no shell: `run_check`
 * maps a small enum onto fixed argv vectors (tsc, jest, git diff/status,
 * node --check) executed by the caller-supplied runner, so the model can
 * verify its work without ever composing a command line.
 *
 * Declarations use the router's provider-neutral `LLMRouterTool` shape, so
 * the same loop runs on DeepSeek (OpenAI-style `tools`) and, on fallback, on
 * Bedrock Claude (`tool_use`) without a second definition.
 */

import { promises as fs, createReadStream, Dirent } from 'fs';
import readline from 'readline';
import path from 'path';
import type { LLMRouterTool } from '../llm-router';
import { matchGlob } from '../dev-autopilot-safety';
import type { RepeatedCheckGuard } from './agent-check-guard';
import { codeIndexRouterTools, isCodeIndexToolName, runCodeIndexTool, type CodeIndexBundle } from '../codeintel-index';

export type CheckKind = 'tsc' | 'jest' | 'git_diff' | 'git_status' | 'node_check';

export interface CheckResult {
  ok: boolean;
  exit_code: number;
  output: string;
}

export interface AgentToolContext {
  /** Absolute path of the clone. Every path argument resolves under it. */
  root: string;
  /** Runs an allowlisted check; the agent runner supplies the real one. */
  runCheck: (kind: CheckKind, target?: string) => Promise<CheckResult>;
  log?: (line: string) => void;
  /** VTID-04016: refuses re-running a check that already failed since the
   *  last edit (Run #4b re-ran an identically failing tsc nine times). */
  checkGuard?: RepeatedCheckGuard;
  /**
   * VTID-04229: the S3-published codebase index for this run, pulled by
   * `pullCodeIndex` (agent-workspace.ts). When absent the three index tools
   * are not declared (see `agentToolsFor`) and, if called anyway, answer
   * with an honest "not available" error instead of a crash.
   */
  codeIndex?: CodeIndexBundle | null;
}

export interface FinishArgs {
  summary: string;
  pr_title: string;
  pr_body: string;
}

export interface ToolOutcome {
  result: string;
  isError?: boolean;
  /** Set when the model called `finish` — the loop stops. */
  finished?: FinishArgs;
}

export const READ_MAX_LINES = 400;
export const READ_MAX_CHARS = 40_000;
export const SEARCH_MAX_RESULTS = 60;
export const SEARCH_MAX_FILES = 25_000;
export const FIND_MAX_RESULTS = 200;
export const CHECK_OUTPUT_MAX_CHARS = 12_000;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'build', '.next', '.cache', 'tmp']);
const TEXT_FILE_MAX_BYTES = 2_000_000;
// VTID-04042: above TEXT_FILE_MAX_BYTES a file is no longer refused — it is
// STREAMED line by line so only the requested window (read_file) or the
// matching lines (search_text) are ever held in memory. Run #6 (VTID-04039)
// spent all 60 turns building a jest-based slicer because read_file said
// "file too large" for the 2.6 MB Command Hub app.js in every range. Only
// files above this hard guard are refused outright.
export const READ_FILE_HARD_MAX_BYTES = 64_000_000;

export const AGENT_TOOLS: LLMRouterTool[] = [
  {
    name: 'read_file',
    description: 'Read a file from the repository (repo-root-relative path). Returns numbered lines. Large files are windowed: pass start_line/end_line to read further.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-root-relative path, e.g. services/gateway/src/services/foo.ts' },
        start_line: { type: 'integer', description: '1-based first line (default 1)' },
        end_line: { type: 'integer', description: `1-based last line (default start_line + ${READ_MAX_LINES - 1})` },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List the entries of a directory (repo-root-relative). Directories end with "/".',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Directory path; "." for the repo root' } }, required: ['path'] },
  },
  {
    name: 'search_text',
    description: `Search file contents with a regular expression (JavaScript syntax). Returns up to ${SEARCH_MAX_RESULTS} matches as path:line: text. Restrict with path (directory) and/or glob (e.g. "**/*.ts").`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for' },
        path: { type: 'string', description: 'Directory to search under (default ".")' },
        glob: { type: 'string', description: 'Glob filter on the repo-root-relative path, e.g. services/gateway/src/**/*.ts' },
        case_insensitive: { type: 'boolean' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'find_files',
    description: `Find files by glob (repo-root-relative, "**" allowed), e.g. "services/gateway/test/**/*watcher*.test.ts". Returns up to ${FIND_MAX_RESULTS} paths.`,
    inputSchema: { type: 'object', properties: { glob: { type: 'string' } }, required: ['glob'] },
  },
  {
    name: 'write_file',
    description: 'Create or fully overwrite a file with the given content. Prefer edit_file for changes to an existing file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact substring in a file. old_string must occur exactly once unless replace_all is true. Returns an error (and changes nothing) if it does not occur or is ambiguous.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'run_check',
    description: 'Run one allowlisted check and return its output. kind=tsc (TypeScript typecheck of a project dir, default services/gateway), jest (run the test file(s) at target — space-separated repo-root-relative paths), node_check (node --check a JS file), git_diff (diff of your changes), git_status.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['tsc', 'jest', 'git_diff', 'git_status', 'node_check'] },
        target: { type: 'string', description: 'tsc: project dir (services/gateway). jest: test file path(s). node_check: file path.' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'finish',
    description: 'Call when the change is complete AND tsc + the relevant jest suites pass. The runner then re-verifies, checks scope, commits, and opens the PR. pr_body: markdown with ## Summary, ## Change, ## Tests.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One paragraph: what changed and why' },
        pr_title: { type: 'string', description: 'Conventional title, e.g. "DEV-AUTOPILOT: name failing checks in CI failure reason"' },
        pr_body: { type: 'string' },
      },
      required: ['summary', 'pr_title', 'pr_body'],
    },
  },
];

/**
 * VTID-04229: dev_index_query / dev_graph_path / dev_get_risk — the same
 * three declarations the Operator Console gets (codeintel-index.ts), in the
 * router's provider-neutral shape. Declared for a run only when its bundle
 * loaded, so a missing index costs the model no wasted turns.
 */
export const CODE_INDEX_TOOLS: LLMRouterTool[] = codeIndexRouterTools();

export function agentToolsFor(ctx: Pick<AgentToolContext, 'codeIndex'>): LLMRouterTool[] {
  return ctx.codeIndex ? [...AGENT_TOOLS, ...CODE_INDEX_TOOLS] : AGENT_TOOLS;
}

/** Resolve a repo-root-relative path inside `root`; throws on any escape. */
export function resolveInsideRoot(root: string, rel: unknown): string {
  if (typeof rel !== 'string' || rel.trim().length === 0) throw new Error('path is required');
  const cleaned = rel.trim().replace(/^\.\/+/, '');
  if (path.isAbsolute(cleaned)) throw new Error(`absolute paths are not allowed: ${rel}`);
  const abs = path.resolve(root, cleaned);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) throw new Error(`path escapes the repository: ${rel}`);
  const relNorm = path.relative(root, abs).split(path.sep).join('/');
  if (relNorm === '.git' || relNorm.startsWith('.git/')) throw new Error('the .git directory is off limits');
  return abs;
}

function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

async function* walk(root: string, dir: string, budget: { files: number }): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (budget.files <= 0) return;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      yield* walk(root, abs, budget);
    } else if (e.isFile()) {
      budget.files -= 1;
      yield abs;
    }
  }
}

/**
 * VTID-04042: stream a file line by line with bounded memory. `onLine` is
 * called for every line (1-based index); returning false stops early. The
 * resolved value is the number of lines visited. A line carrying a NUL byte
 * marks the file as binary and aborts with `null`.
 */
async function streamLines(abs: string, onLine: (line: string, lineNo: number) => boolean | void): Promise<number | null> {
  const input = createReadStream(abs, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      n += 1;
      if (line.includes('\0')) return null;
      if (onLine(line, n) === false) break;
    }
  } finally {
    rl.close();
    input.destroy();
  }
  return n;
}

/** VTID-04042: the read_file window for a file too large to load whole. */
async function readWindowStreaming(abs: string, start: number, endWanted: number): Promise<{ slice: string[]; totalLines: number } | null> {
  const slice: string[] = [];
  const total = await streamLines(abs, (line, no) => {
    if (no >= start && no <= endWanted) slice.push(line);
    return undefined;
  });
  if (total === null) return null;
  return { slice, totalLines: total };
}

function numbered(lines: string[], start: number): string {
  return lines.map((l, i) => `${String(start + i).padStart(5)}\t${l}`).join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

export async function executeAgentTool(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const args = rawArgs || {};
  const log = ctx.log || (() => undefined);
  try {
    // VTID-04163: refuse an exact-repeat navigation call before doing any
    // work — see agent-check-guard.ts's RepeatedCheckGuard.shouldRefuseNav.
    if (name === 'read_file' || name === 'search_text' || name === 'list_dir' || name === 'find_files') {
      const refusal = ctx.checkGuard?.shouldRefuseNav(name, args);
      if (refusal) {
        log(`${name} refused by the repeated-navigation guard`);
        return { result: refusal, isError: true };
      }
    }
    // VTID-04229: codebase index tools — pure functions over the loaded
    // bundle; no file system access, no subprocess.
    if (isCodeIndexToolName(name)) {
      if (!ctx.codeIndex) return { result: `${name} is not available in this run (no codebase index was loaded — use search_text / find_files instead)`, isError: true };
      const out = runCodeIndexTool(name, args, ctx.codeIndex);
      log(`${name} ${JSON.stringify(args).slice(0, 160)} → ${out.ok ? 'ok' : 'error'}`);
      return { result: out.text, isError: !out.ok };
    }
    switch (name) {
      case 'read_file': {
        const abs = resolveInsideRoot(ctx.root, args.path);
        const st = await fs.stat(abs);
        if (!st.isFile()) return { result: `not a file: ${args.path}`, isError: true };
        if (st.size > READ_FILE_HARD_MAX_BYTES) return { result: `file too large to read (${st.size} bytes; hard limit ${READ_FILE_HARD_MAX_BYTES})`, isError: true };
        const start = Math.max(1, Number(args.start_line) || 1);
        const endWanted = Number(args.end_line) || start + READ_MAX_LINES - 1;
        let slice: string[];
        let totalLines: number;
        if (st.size > TEXT_FILE_MAX_BYTES) {
          // VTID-04042: too big to load whole — stream only the window.
          const win = await readWindowStreaming(abs, start, endWanted);
          if (!win) return { result: `binary file: ${args.path}`, isError: true };
          slice = win.slice;
          totalLines = win.totalLines;
        } else {
          const text = await fs.readFile(abs, 'utf8');
          const lines = text.split('\n');
          totalLines = lines.length;
          slice = lines.slice(start - 1, Math.min(lines.length, endWanted));
        }
        const end = Math.min(totalLines, endWanted);
        let out = numbered(slice, start);
        if (out.length > READ_MAX_CHARS) out = `${out.slice(0, READ_MAX_CHARS)}\n…[window truncated; request a narrower range]`;
        const more = end < totalLines ? `\n[${totalLines - end} more line(s); file has ${totalLines} lines — read from start_line=${end + 1}]` : `\n[end of file, ${totalLines} lines]`;
        log(`read_file ${args.path} ${start}-${end}`);
        return { result: out + more };
      }
      case 'list_dir': {
        const abs = resolveInsideRoot(ctx.root, args.path === '.' || args.path === undefined ? '.' : args.path);
        const entries = await fs.readdir(abs, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        const rows = entries.filter((e) => e.name !== '.git').map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return { result: rows.length ? rows.join('\n') : '(empty)' };
      }
      case 'search_text': {
        const pattern = String(args.pattern || '');
        if (!pattern) return { result: 'pattern is required', isError: true };
        let re: RegExp;
        try {
          re = new RegExp(pattern, args.case_insensitive ? 'i' : '');
        } catch (err) {
          return { result: `invalid regex: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
        const base = resolveInsideRoot(ctx.root, typeof args.path === 'string' && args.path ? args.path : '.');
        const glob = typeof args.glob === 'string' && args.glob ? args.glob : null;
        const hits: string[] = [];
        const budget = { files: SEARCH_MAX_FILES };
        const started = Date.now();
        for await (const abs of walk(ctx.root, base, budget)) {
          if (hits.length >= SEARCH_MAX_RESULTS || Date.now() - started > 15_000) break;
          const rel = toRel(ctx.root, abs);
          if (glob && !matchGlob(rel, glob)) continue;
          let text: string;
          try {
            const st = await fs.stat(abs);
            if (st.size > READ_FILE_HARD_MAX_BYTES) continue;
            if (st.size > TEXT_FILE_MAX_BYTES) {
              // VTID-04042: too big to load whole — stream it; a binary file
              // (NUL byte) is skipped exactly like the in-memory branch does.
              await streamLines(abs, (line, no) => {
                if (re.test(line)) hits.push(`${rel}:${no}: ${line.trim().slice(0, 200)}`);
                return hits.length < SEARCH_MAX_RESULTS;
              });
              continue;
            }
            text = await fs.readFile(abs, 'utf8');
          } catch {
            continue;
          }
          if (text.includes('\0')) continue; // binary
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && hits.length < SEARCH_MAX_RESULTS; i++) {
            if (re.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        }
        log(`search_text /${pattern}/ → ${hits.length}`);
        return { result: hits.length ? hits.join('\n') + (hits.length >= SEARCH_MAX_RESULTS ? '\n…[more matches; narrow the search]' : '') : '(no matches)' };
      }
      case 'find_files': {
        const glob = String(args.glob || '');
        if (!glob) return { result: 'glob is required', isError: true };
        const out: string[] = [];
        const budget = { files: SEARCH_MAX_FILES };
        for await (const abs of walk(ctx.root, ctx.root, budget)) {
          const rel = toRel(ctx.root, abs);
          if (matchGlob(rel, glob)) {
            out.push(rel);
            if (out.length >= FIND_MAX_RESULTS) break;
          }
        }
        return { result: out.length ? out.join('\n') : '(no files match)' };
      }
      case 'write_file': {
        const abs = resolveInsideRoot(ctx.root, args.path);
        if (typeof args.content !== 'string') return { result: 'content must be a string', isError: true };
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, args.content, 'utf8');
        ctx.checkGuard?.markEdited();
        log(`write_file ${args.path} (${args.content.length} chars)`);
        return { result: `wrote ${args.path} (${args.content.split('\n').length} lines)` };
      }
      case 'edit_file': {
        const abs = resolveInsideRoot(ctx.root, args.path);
        const oldS = String(args.old_string ?? '');
        const newS = String(args.new_string ?? '');
        if (!oldS) return { result: 'old_string must be non-empty', isError: true };
        const text = await fs.readFile(abs, 'utf8');
        const count = text.split(oldS).length - 1;
        if (count === 0) return { result: `old_string not found in ${args.path}`, isError: true };
        if (count > 1 && !args.replace_all) return { result: `old_string occurs ${count} times in ${args.path}; add more context or set replace_all`, isError: true };
        const next = args.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
        await fs.writeFile(abs, next, 'utf8');
        ctx.checkGuard?.markEdited();
        log(`edit_file ${args.path} (${count} replacement${count === 1 ? '' : 's'})`);
        return { result: `edited ${args.path}: ${count} replacement${count === 1 ? '' : 's'}` };
      }
      case 'delete_file': {
        const abs = resolveInsideRoot(ctx.root, args.path);
        await fs.unlink(abs);
        ctx.checkGuard?.markEdited();
        log(`delete_file ${args.path}`);
        return { result: `deleted ${args.path}` };
      }
      case 'run_check': {
        const kind = String(args.kind || '') as CheckKind;
        if (!['tsc', 'jest', 'git_diff', 'git_status', 'node_check'].includes(kind)) {
          return { result: `unknown check kind: ${kind}`, isError: true };
        }
        const target = typeof args.target === 'string' ? args.target : undefined;
        if (target) {
          // Every target must live in the repo — validated before anything runs.
          for (const t of target.split(/\s+/).filter(Boolean)) resolveInsideRoot(ctx.root, t);
        }
        const refusal = ctx.checkGuard?.shouldRefuse(kind, target);
        if (refusal) {
          log(`run_check ${kind} ${target || ''} → refused by the repeated-check guard`);
          return { result: refusal, isError: true };
        }
        const r = await ctx.runCheck(kind, target);
        ctx.checkGuard?.record(kind, target, r.ok);
        log(`run_check ${kind} ${target || ''} → exit ${r.exit_code}`);
        return { result: `exit_code=${r.exit_code}\n${truncate(r.output, CHECK_OUTPUT_MAX_CHARS)}`, isError: !r.ok };
      }
      case 'finish': {
        const summary = String(args.summary || '').trim();
        const pr_title = String(args.pr_title || '').trim();
        const pr_body = String(args.pr_body || '').trim();
        if (!summary || !pr_title || !pr_body) return { result: 'finish requires summary, pr_title and pr_body', isError: true };
        return { result: 'finish acknowledged — the runner will verify, check scope, commit and open the PR', finished: { summary, pr_title, pr_body } };
      }
      default:
        return { result: `unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return { result: `${name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
