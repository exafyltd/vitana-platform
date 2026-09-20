/**
 * VTID-04016: repeated-identical-check guard + agent-aware commands.log.
 *
 * Test Run #4b (VTID-04012, execution 4f7d5ea4): the model re-ran an
 * identically failing `run_check tsc` nine times with no edit in between
 * (~18 of its 22 minutes). These tests pin the guard's rule and its wiring
 * through the real tool surface, and that the VTID-04002 evidence pack's
 * commands.log describes the agent path when the agent produced the diff.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { MAX_FAILED_ATTEMPTS_WITHOUT_EDIT, MAX_NAV_REPEATS_WITHOUT_EDIT, RepeatedCheckGuard, checkGuardKey, navGuardKey } from '../src/services/autopilot-agent/agent-check-guard';
import { executeAgentTool, type AgentToolContext, type CheckKind } from '../src/services/autopilot-agent/agent-tools';
import { applyPrContract, buildCommandsLog, type PrContractInput } from '../src/services/dev-autopilot-pr-contract';

describe('VTID-04016 RepeatedCheckGuard (pure)', () => {
  it('allows the first attempts of a failing check, refuses once the cap is reached, and an edit resets it', () => {
    const g = new RepeatedCheckGuard();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS_WITHOUT_EDIT; i++) {
      expect(g.shouldRefuse('tsc', 'services/gateway')).toBeNull();
      g.record('tsc', 'services/gateway', false);
    }
    const refusal = g.shouldRefuse('tsc', 'services/gateway');
    expect(refusal).toMatch(/already failed 2 time\(s\) since your last file edit/);
    expect(refusal).toMatch(/edit_file\/write_file first/);
    expect(g.refusedCount()).toBe(1);
    g.markEdited();
    expect(g.shouldRefuse('tsc', 'services/gateway')).toBeNull();
  });

  it('a passing run never counts, and keys are per (kind, target)', () => {
    const g = new RepeatedCheckGuard();
    g.record('jest', 'a.test.ts', false);
    g.record('jest', 'a.test.ts', true);
    g.record('jest', 'a.test.ts', false);
    expect(g.shouldRefuse('jest', 'a.test.ts')).not.toBeNull();
    expect(g.shouldRefuse('jest', 'b.test.ts')).toBeNull();
    expect(g.shouldRefuse('tsc', 'a.test.ts')).toBeNull();
    expect(checkGuardKey('tsc')).toBe('tsc');
    expect(checkGuardKey('jest', ' x.test.ts ')).toBe('jest x.test.ts');
  });

  it('never guards git_diff / git_status (inspections, not checks)', () => {
    const g = new RepeatedCheckGuard();
    for (let i = 0; i < 5; i++) { g.record('git_status', undefined, false); g.record('git_diff', undefined, false); }
    expect(g.shouldRefuse('git_status')).toBeNull();
    expect(g.shouldRefuse('git_diff')).toBeNull();
  });
});

describe('VTID-04163 repeated-navigation guard (pure)', () => {
  it('allows the first call, refuses an exact repeat, and an edit resets it', () => {
    const g = new RepeatedCheckGuard();
    for (let i = 0; i < MAX_NAV_REPEATS_WITHOUT_EDIT; i++) {
      expect(g.shouldRefuseNav('read_file', { path: 'x.ts' })).toBeNull();
    }
    const refusal = g.shouldRefuseNav('read_file', { path: 'x.ts' });
    expect(refusal).toMatch(/already called it with these exact arguments/);
    expect(refusal).toMatch(/Act on the content you already retrieved/);
    expect(g.navRefusedCount()).toBe(1);
    g.markEdited();
    expect(g.shouldRefuseNav('read_file', { path: 'x.ts' })).toBeNull();
  });

  it('different arguments (or key order) are distinct calls; unguarded tools are never refused', () => {
    const g = new RepeatedCheckGuard();
    expect(g.shouldRefuseNav('read_file', { path: 'x.ts', start_line: 1 })).toBeNull();
    expect(g.shouldRefuseNav('read_file', { path: 'x.ts', start_line: 40 })).toBeNull();
    expect(g.shouldRefuseNav('read_file', { start_line: 1, path: 'x.ts' })).not.toBeNull(); // same key, different order
    expect(navGuardKey('read_file', { a: 1, b: 2 })).toBe(navGuardKey('read_file', { b: 2, a: 1 }));
    for (let i = 0; i < 5; i++) expect(g.shouldRefuseNav('write_file', { path: 'x.ts', content: 'x' })).toBeNull();
  });
});

describe('VTID-04016 guard wired through executeAgentTool', () => {
  let root: string;
  let ctx: AgentToolContext;
  let runs: CheckKind[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-guard-'));
    await fs.mkdir(path.join(root, 'services/gateway'), { recursive: true });
    await fs.writeFile(path.join(root, 'services/gateway/x.ts'), 'export const x = 1;\n');
    runs = [];
    ctx = {
      root,
      checkGuard: new RepeatedCheckGuard(),
      runCheck: async (kind) => { runs.push(kind); return { ok: false, exit_code: 2, output: 'error TS2742 same output' }; },
    };
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('the third identical failing tsc is refused without running; an edit re-enables it', async () => {
    const a = await executeAgentTool('run_check', { kind: 'tsc', target: 'services/gateway' }, ctx);
    const b = await executeAgentTool('run_check', { kind: 'tsc', target: 'services/gateway' }, ctx);
    expect(a.isError && b.isError).toBe(true);
    expect(runs).toEqual(['tsc', 'tsc']);
    const c = await executeAgentTool('run_check', { kind: 'tsc', target: 'services/gateway' }, ctx);
    expect(c.isError).toBe(true);
    expect(c.result).toMatch(/refused/);
    expect(runs).toHaveLength(2); // not run
    await executeAgentTool('edit_file', { path: 'services/gateway/x.ts', old_string: 'x = 1', new_string: 'x = 2' }, ctx);
    const d = await executeAgentTool('run_check', { kind: 'tsc', target: 'services/gateway' }, ctx);
    expect(d.result).toMatch(/exit_code=2/);
    expect(runs).toHaveLength(3);
  });

  it('write_file and delete_file also reset the guard', async () => {
    for (let i = 0; i < 2; i++) await executeAgentTool('run_check', { kind: 'jest', target: 'services/gateway/x.ts' }, ctx);
    expect((await executeAgentTool('run_check', { kind: 'jest', target: 'services/gateway/x.ts' }, ctx)).result).toMatch(/refused/);
    await executeAgentTool('write_file', { path: 'services/gateway/y.ts', content: 'export const y = 1;\n' }, ctx);
    expect((await executeAgentTool('run_check', { kind: 'jest', target: 'services/gateway/x.ts' }, ctx)).result).not.toMatch(/refused/);
    for (let i = 0; i < 2; i++) await executeAgentTool('run_check', { kind: 'jest', target: 'services/gateway/x.ts' }, ctx);
    expect((await executeAgentTool('run_check', { kind: 'jest', target: 'services/gateway/x.ts' }, ctx)).result).toMatch(/refused/);
    await executeAgentTool('delete_file', { path: 'services/gateway/y.ts' }, ctx);
    expect((await executeAgentTool('run_check', { kind: 'jest', target: 'services/gateway/x.ts' }, ctx)).result).not.toMatch(/refused/);
  });

  it('a context without a guard behaves exactly as before (no refusals ever)', async () => {
    const plain: AgentToolContext = { root, runCheck: ctx.runCheck };
    for (let i = 0; i < 5; i++) {
      expect((await executeAgentTool('run_check', { kind: 'tsc' }, plain)).result).not.toMatch(/refused/);
    }
    expect(runs).toHaveLength(5);
  });

  it('VTID-04163: an exact-repeat read_file is refused; a different range is not; an edit resets it', async () => {
    const a = await executeAgentTool('read_file', { path: 'services/gateway/x.ts' }, ctx);
    expect(a.isError).toBeFalsy();
    const b = await executeAgentTool('read_file', { path: 'services/gateway/x.ts' }, ctx);
    expect(b.isError).toBe(true);
    expect(b.result).toMatch(/refused/);
    const c = await executeAgentTool('read_file', { path: 'services/gateway/x.ts', start_line: 1, end_line: 1 }, ctx);
    expect(c.isError).toBeFalsy(); // different args, not a repeat
    await executeAgentTool('edit_file', { path: 'services/gateway/x.ts', old_string: 'x = 1', new_string: 'x = 2' }, ctx);
    const d = await executeAgentTool('read_file', { path: 'services/gateway/x.ts' }, ctx);
    expect(d.isError).toBeFalsy();
  });

  it('VTID-04163: search_text/list_dir/find_files are guarded too; write_file/finish are never guarded', async () => {
    await executeAgentTool('search_text', { pattern: 'x', path: 'services/gateway' }, ctx);
    expect((await executeAgentTool('search_text', { pattern: 'x', path: 'services/gateway' }, ctx)).result).toMatch(/refused/);
    await executeAgentTool('list_dir', { path: 'services/gateway' }, ctx);
    expect((await executeAgentTool('list_dir', { path: 'services/gateway' }, ctx)).result).toMatch(/refused/);
    await executeAgentTool('find_files', { glob: '**/*.ts' }, ctx);
    expect((await executeAgentTool('find_files', { glob: '**/*.ts' }, ctx)).result).toMatch(/refused/);
    for (let i = 0; i < 3; i++) {
      expect((await executeAgentTool('write_file', { path: 'services/gateway/z.ts', content: 'x' }, ctx)).isError).toBeFalsy();
    }
  });
});

describe('VTID-04016 commands.log describes the executor that ran', () => {
  const base: PrContractInput = {
    vtid: 'VTID-04016', title: 'x', body: 'y',
    files: [{ path: 'services/gateway/src/services/a.ts', action: 'modify' }, { path: 'services/gateway/test/a.test.ts', action: 'create' }],
    executionId: 'e-1', findingId: 'f-1', planVersion: 1, branch: 'dev-autopilot/e1', baseBranch: 'main',
    provider: 'deepseek', model: 'deepseek-flash', now: '2026-09-17T21:00:00.000Z',
  };

  it('default (single-shot) wording is unchanged', () => {
    const log = buildCommandsLog({ ...base, vtid: 'VTID-04016' });
    expect(log).toContain('(single-shot executor)');
    expect(log).toContain("callViaRouter('worker') → parse <<<PR_TITLE>>>");
    expect(log).not.toContain('tool loop');
  });

  it('agent executor: clone, tool loop, guard, runner tsc + jest, fix rounds, push', () => {
    const log = buildCommandsLog({
      ...base, vtid: 'VTID-04016', executor: 'agent',
      agentStats: { turns: 17, fixRounds: 1, checksRefused: 3, navRepeatsRefused: 2, fallbackUsed: false, tscRun: true },
    });
    expect(log).toContain('(agent executor, VTID-04006)');
    expect(log).toContain('# agent turns=17 fix_rounds=1 checks_refused_by_guard=3 nav_repeats_refused_by_guard=2 fallback_used=false');
    expect(log).toContain('git clone --depth 1 --branch main');
    expect(log).toMatch(/tool loop on callViaRouter\('worker'\)/);
    expect(log).toMatch(/refuses a check that already failed since the last edit \(VTID-04016\)/);
    expect(log).toMatch(/tsc --noEmit -p tsconfig.json --preserveSymlinks/);
    expect(log).toContain('$ git rm services/gateway/src/services/a.ts   # modify'.replace('git rm', 'git add'));
    expect(log).toContain('git push origin dev-autopilot/e1');
    expect(log).not.toContain('<<<PR_TITLE>>>');
  });

  it('records a skipped runner tsc honestly', () => {
    const log = buildCommandsLog({ ...base, vtid: 'VTID-04016', executor: 'agent', agentStats: { turns: 1, fixRounds: 0, checksRefused: 0, navRepeatsRefused: 0, fallbackUsed: true, tscRun: false } });
    expect(log).toContain('# runner tsc skipped (AGENT_SKIP_TSC=true)');
    expect(log).toContain('fallback_used=true');
  });

  it('applyPrContract threads executor through to the evidence pack', () => {
    const out = applyPrContract({ ...base, executor: 'agent', agentStats: { turns: 2, fixRounds: 0, checksRefused: 0, navRepeatsRefused: 0, fallbackUsed: false, tscRun: true } });
    const log = out.evidenceFiles.find((f) => f.path.endsWith('commands.log'))!.content;
    expect(log).toContain('(agent executor, VTID-04006)');
  });
});
