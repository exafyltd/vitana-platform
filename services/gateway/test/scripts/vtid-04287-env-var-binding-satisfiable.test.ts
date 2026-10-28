/**
 * VTID-04287 — the env-var binding rule must be satisfiable by its own remedy.
 *
 * `new-env-var-requires-workflow-binding` has always printed a suggested_action
 * that offers, as option (c): "if it's truly optional, add a defensive
 * `process.env.X ?? 'default'` at the call site." Its check() only ever grepped
 * workflow / .env.example / deploy-config TEXT for the var name, so a diff whose
 * added lines already had a fallback was still reported — the gate could not be
 * cleared by the remedy the gate itself recommended.
 *
 * Real cost, measured: the finding for HARNESS_URL / OUT_DIR / TABS in the
 * VTID-04282 harness-shoot output script (all three read through `|| <default>`
 * on their own added line) was re-executed 461 times over 12.5 hours
 * (VTID-04368 live evidence). An unsatisfiable gate gets satisfied dishonestly
 * or not at all; VTID-03696 established that is worse than no gate.
 *
 * The rule is an ES module, so it is exercised through a child `node` process —
 * the code CI actually runs, not a restatement of it.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../../..');
const RULE = path.join(REPO, 'scripts/ci/impact-rules/new-env-var-requires-workflow-binding.mjs');

jest.setTimeout(60000);

interface Finding {
  rule: string;
  message: string;
  raw?: { missing_env_vars?: string[]; bound_at_call_site?: string[] };
}

function runNode(code: string): any {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

/** `check()` over a synthetic diff — no repo file has to change. */
function check(addedLines: string[] | string, file = 'scripts/probe.js'): Finding[] {
  const lines = typeof addedLines === 'string' ? addedLines.split('\n') : addedLines;
  const diff = [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,1 +1,1 @@',
    ...lines.map((l) => `+${l}`),
  ].join('\n');
  return runNode(
    `import { check } from ${JSON.stringify(RULE)};` +
      `const f = await check({ diff: ${JSON.stringify(diff)}, repoRoot: process.cwd() });` +
      `process.stdout.write(JSON.stringify(f));`,
  );
}

/** The rule's own helper, for the fine-grained operator cases. */
function bound(line: string, varName: string): boolean {
  return runNode(
    `import { hasDefensiveFallback } from ${JSON.stringify(RULE)};` +
      `process.stdout.write(JSON.stringify(hasDefensiveFallback(${JSON.stringify(line)}, ${JSON.stringify(varName)})));`,
  );
}

describe('VTID-04287: new-env-var-requires-workflow-binding is satisfiable', () => {
  it('returns no finding for the motivating diff — every added line has a defensive fallback', () => {
    // The three shapes from docs/validation/VTID-04282/outputs/harness-shoot.js.
    const findings = check([
      `const BASE = process.env.VTID04287_HARNESS_URL || 'http://127.0.0.1:18482';`,
      'const OUT = process.env.VTID04287_OUT_DIR || __dirname;',
      `const TABS = (process.env.VTID04287_TABS || 'live,scanners').split(',');`,
    ]);
    expect(findings).toEqual([]);
  });

  it('accepts the canonical `?? ` remedy the rule itself recommends', () => {
    const findings = check([
      `const base = process.env.VTID04287_PROBE_A ?? 'http://127.0.0.1:18482';`,
      'const out = process.env.VTID04287_PROBE_B ?? __dirname;',
      'const width = process.env.VTID04287_PROBE_C ?? 2;',
    ]);
    expect(findings).toEqual([]);
  });

  it('still reports a bare read — the gate is not a rubber stamp for any added line', () => {
    const findings = check(['const url = process.env.VTID04287_UNBOUND_A;']);
    expect(findings).toHaveLength(1);
    expect(findings[0].raw?.missing_env_vars).toEqual(['VTID04287_UNBOUND_A']);
  });

  it('still reports a read that is only one line of a multi-line addition', () => {
    const findings = check([
      'const cfg = {',
      '  url: process.env.VTID04287_UNBOUND_B,',
      `  tabs: (process.env.VTID04287_BOUND_B || '2'),`,
      '};',
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].raw?.missing_env_vars).toEqual(['VTID04287_UNBOUND_B']);
    // The bound var is named in the raw payload, so the finding shows what was
    // accepted as well as what was not.
    expect(findings[0].raw?.bound_at_call_site).toEqual(['VTID04287_BOUND_B']);
  });

  it('flags a var that is bound on one line and read bare on another', () => {
    const findings = check([
      `const a = process.env.VTID04287_MIXED_A || 'x';`,
      'const b = process.env.VTID04287_MIXED_A;',
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].raw?.missing_env_vars).toEqual(['VTID04287_MIXED_A']);
  });

  it('does not treat `|| undefined` as a binding — that is still an undefined read', () => {
    expect(bound('const a = process.env.VTID04287_UNDEF_A || undefined;', 'VTID04287_UNDEF_A')).toBe(false);
    expect(bound('const a = process.env.VTID04287_UNDEF_B ?? undefined;', 'VTID04287_UNDEF_B')).toBe(false);
  });

  it('does not treat `|| process.env.OTHER` as a binding — OTHER may itself be unset', () => {
    expect(bound('const a = process.env.VTID04287_CHAIN_A || process.env.VTID04287_CHAIN_B;', 'VTID04287_CHAIN_A')).toBe(false);
    expect(bound('const a = process.env.VTID04287_CHAIN_C ?? process.env.VTID04287_CHAIN_D;', 'VTID04287_CHAIN_C')).toBe(false);
  });

  it('does not treat a read used AS the fallback as a binding', () => {
    expect(bound("const a = something || process.env.VTID04287_TAIL_A;", 'VTID04287_TAIL_A')).toBe(false);
  });

  it('accepts literal, template, number, boolean and null fallbacks', () => {
    expect(bound(`const a = process.env.VTID04287_OK_A ?? 'x';`, 'VTID04287_OK_A')).toBe(true);
    expect(bound('const a = process.env.VTID04287_OK_B ?? `./out/${id}`;', 'VTID04287_OK_B')).toBe(true);
    expect(bound('const a = process.env.VTID04287_OK_C ?? 2;', 'VTID04287_OK_C')).toBe(true);
    expect(bound('const a = process.env.VTID04287_OK_D || false;', 'VTID04287_OK_D')).toBe(true);
    expect(bound('const a = process.env.VTID04287_OK_E || null;', 'VTID04287_OK_E')).toBe(true);
    expect(bound('const a = parseInt(process.env.VTID04287_OK_F ?? "2", 10);', 'VTID04287_OK_F')).toBe(true);
  });

  it('accepts a bare identifier fallback, which is how the harness scripts read OUT_DIR', () => {
    expect(bound('const OUT = process.env.VTID04287_DIR_A || __dirname;', 'VTID04287_DIR_A')).toBe(true);
    expect(bound('const p = process.env.VTID04287_DIR_B ?? paths.out;', 'VTID04287_DIR_B')).toBe(true);
  });

  it('accepts a later fallback when the line has more than one', () => {
    // The RHS of the FIRST operator must not be swallowed by a later `??`.
    expect(bound("const a = process.env.VTID04287_MULTI_A || __dirname + (x ?? 'y');", 'VTID04287_MULTI_A')).toBe(true);
  });
});
