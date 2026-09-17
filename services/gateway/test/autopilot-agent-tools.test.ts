/**
 * VTID-04006: agent tool surface — path jail, file ops, search, checks, finish.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  AGENT_TOOLS,
  executeAgentTool,
  resolveInsideRoot,
  READ_MAX_LINES,
  type AgentToolContext,
  type CheckKind,
} from '../src/services/autopilot-agent/agent-tools';

let root: string;
let ctx: AgentToolContext;
let checks: Array<{ kind: CheckKind; target?: string }>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-tools-'));
  await fs.mkdir(path.join(root, 'services/gateway/src/services'), { recursive: true });
  await fs.mkdir(path.join(root, 'services/gateway/test'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules/dep'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.writeFile(path.join(root, 'services/gateway/src/services/foo.ts'), 'export function foo() {\n  return 1;\n}\nexport const bar = 2;\n');
  await fs.writeFile(path.join(root, 'services/gateway/test/foo.test.ts'), "import { foo } from '../src/services/foo';\ntest('foo', () => expect(foo()).toBe(1));\n");
  await fs.writeFile(path.join(root, 'node_modules/dep/index.js'), 'export function foo() {}');
  await fs.writeFile(path.join(root, '.git/HEAD'), 'ref: refs/heads/main');
  checks = [];
  ctx = {
    root,
    runCheck: async (kind, target) => { checks.push({ kind, target }); return { ok: kind !== 'jest', exit_code: kind === 'jest' ? 1 : 0, output: `${kind} output` }; },
  };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('VTID-04006 resolveInsideRoot (path jail)', () => {
  it('resolves repo-relative paths and rejects escapes, absolutes and .git', () => {
    expect(resolveInsideRoot(root, 'services/gateway/src/services/foo.ts')).toBe(path.join(root, 'services/gateway/src/services/foo.ts'));
    expect(resolveInsideRoot(root, './services/gateway')).toBe(path.join(root, 'services/gateway'));
    expect(() => resolveInsideRoot(root, '../etc/passwd')).toThrow(/escapes/);
    expect(() => resolveInsideRoot(root, 'services/../../x')).toThrow(/escapes/);
    expect(() => resolveInsideRoot(root, '/etc/passwd')).toThrow(/absolute/);
    expect(() => resolveInsideRoot(root, '.git/config')).toThrow(/off limits/);
    expect(() => resolveInsideRoot(root, '')).toThrow(/required/);
  });
});

describe('VTID-04006 executeAgentTool', () => {
  it('declares every tool the loop can be asked for', () => {
    const names = AGENT_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(['delete_file', 'edit_file', 'find_files', 'finish', 'list_dir', 'read_file', 'run_check', 'search_text', 'write_file']);
    for (const t of AGENT_TOOLS) expect(t.inputSchema).toHaveProperty('type', 'object');
  });

  it('read_file returns numbered lines and windows large files', async () => {
    const r = await executeAgentTool('read_file', { path: 'services/gateway/src/services/foo.ts' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.result).toMatch(/^\s+1\texport function foo\(\)/);
    expect(r.result).toContain('[end of file, 5 lines]');
    const big = Array.from({ length: READ_MAX_LINES + 50 }, (_, i) => `line ${i + 1}`).join('\n');
    await fs.writeFile(path.join(root, 'big.txt'), big);
    const w = await executeAgentTool('read_file', { path: 'big.txt' }, ctx);
    expect(w.result).toContain(`read from start_line=${READ_MAX_LINES + 1}`);
    const w2 = await executeAgentTool('read_file', { path: 'big.txt', start_line: READ_MAX_LINES + 1 }, ctx);
    expect(w2.result).toContain(`line ${READ_MAX_LINES + 1}`);
    expect(w2.result).toContain('[end of file');
  });

  it('read_file on a missing file or an escape is an error, not a throw', async () => {
    expect((await executeAgentTool('read_file', { path: 'nope.ts' }, ctx)).isError).toBe(true);
    const esc = await executeAgentTool('read_file', { path: '../../etc/hosts' }, ctx);
    expect(esc.isError).toBe(true);
    expect(esc.result).toMatch(/escapes/);
  });

  it('list_dir marks directories and hides .git', async () => {
    const r = await executeAgentTool('list_dir', { path: '.' }, ctx);
    expect(r.result.split('\n')).toEqual(expect.arrayContaining(['services/', 'node_modules/']));
    expect(r.result).not.toContain('.git');
  });

  it('search_text skips node_modules/.git and honours a glob filter', async () => {
    const r = await executeAgentTool('search_text', { pattern: 'function foo' }, ctx);
    expect(r.result).toContain('services/gateway/src/services/foo.ts:1: export function foo() {');
    expect(r.result).not.toContain('node_modules');
    const g = await executeAgentTool('search_text', { pattern: 'foo', glob: 'services/gateway/test/**' }, ctx);
    expect(g.result).toContain('services/gateway/test/foo.test.ts');
    expect(g.result).not.toContain('src/services/foo.ts');
    expect((await executeAgentTool('search_text', { pattern: '(' }, ctx)).isError).toBe(true);
    expect((await executeAgentTool('search_text', { pattern: 'zzz-no-such' }, ctx)).result).toBe('(no matches)');
  });

  it('find_files matches repo-relative globs', async () => {
    const r = await executeAgentTool('find_files', { glob: 'services/gateway/**/*.test.ts' }, ctx);
    expect(r.result).toBe('services/gateway/test/foo.test.ts');
  });

  it('write_file creates directories; edit_file requires a unique match; delete_file removes', async () => {
    const w = await executeAgentTool('write_file', { path: 'services/gateway/src/new/thing.ts', content: 'export const x = 1;\n' }, ctx);
    expect(w.isError).toBeFalsy();
    expect(await fs.readFile(path.join(root, 'services/gateway/src/new/thing.ts'), 'utf8')).toBe('export const x = 1;\n');

    const e = await executeAgentTool('edit_file', { path: 'services/gateway/src/services/foo.ts', old_string: 'return 1;', new_string: 'return 42;' }, ctx);
    expect(e.isError).toBeFalsy();
    expect(await fs.readFile(path.join(root, 'services/gateway/src/services/foo.ts'), 'utf8')).toContain('return 42;');

    const missing = await executeAgentTool('edit_file', { path: 'services/gateway/src/services/foo.ts', old_string: 'nope', new_string: 'x' }, ctx);
    expect(missing.isError).toBe(true);
    await fs.writeFile(path.join(root, 'dup.txt'), 'a a a');
    const amb = await executeAgentTool('edit_file', { path: 'dup.txt', old_string: 'a', new_string: 'b' }, ctx);
    expect(amb.isError).toBe(true);
    expect(amb.result).toMatch(/occurs 3 times/);
    const all = await executeAgentTool('edit_file', { path: 'dup.txt', old_string: 'a', new_string: 'b', replace_all: true }, ctx);
    expect(all.isError).toBeFalsy();
    expect(await fs.readFile(path.join(root, 'dup.txt'), 'utf8')).toBe('b b b');

    const d = await executeAgentTool('delete_file', { path: 'dup.txt' }, ctx);
    expect(d.isError).toBeFalsy();
    await expect(fs.access(path.join(root, 'dup.txt'))).rejects.toBeTruthy();
  });

  it('run_check only accepts allowlisted kinds, validates targets, and reports exit codes', async () => {
    const ok = await executeAgentTool('run_check', { kind: 'tsc', target: 'services/gateway' }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(ok.result).toContain('exit_code=0');
    expect(checks).toEqual([{ kind: 'tsc', target: 'services/gateway' }]);
    const fail = await executeAgentTool('run_check', { kind: 'jest', target: 'services/gateway/test/foo.test.ts' }, ctx);
    expect(fail.isError).toBe(true);
    expect(fail.result).toContain('exit_code=1');
    const bad = await executeAgentTool('run_check', { kind: 'rm -rf' }, ctx);
    expect(bad.isError).toBe(true);
    expect(checks).toHaveLength(2);
    const esc = await executeAgentTool('run_check', { kind: 'jest', target: '../outside.test.ts' }, ctx);
    expect(esc.isError).toBe(true);
    expect(checks).toHaveLength(2);
  });

  it('finish returns the finished payload only when complete', async () => {
    const bad = await executeAgentTool('finish', { summary: 'x' }, ctx);
    expect(bad.isError).toBe(true);
    const good = await executeAgentTool('finish', { summary: 's', pr_title: 't', pr_body: 'b' }, ctx);
    expect(good.finished).toEqual({ summary: 's', pr_title: 't', pr_body: 'b' });
  });

  it('unknown tools are errors', async () => {
    expect((await executeAgentTool('shell', {}, ctx)).isError).toBe(true);
  });
});
