/**
 * VTID-04287 — `new-env-var-requires-workflow-binding` was an unsatisfiable
 * gate for the exact fix it recommends.
 *
 * The rule's own suggested_action (c) says "if it's truly optional, add a
 * defensive `process.env.X ?? 'default'` at the call site". But `check()`
 * only ever looked for the var NAME in workflow/.env.example text — it never
 * inspected the added line at all — so a call site written to the letter of
 * that advice still got reported. Measured on the finding that opened this
 * task: `HARNESS_URL`, `OUT_DIR`, `TABS` in
 * `docs/validation/VTID-04282/outputs/harness-shoot.js:5-7`, each already
 * `process.env.X || '<default>'`.
 *
 * An unsatisfiable gate does not get satisfied honestly; it gets satisfied by
 * widening a denylist or by editing CI config to silence it. So this test runs
 * the rule's real `check()` through a real Node ESM process (the same
 * mechanism CI uses — `scripts/ci/impact-rules/*.mjs` is zero-dep plain ESM
 * that Jest's CJS/ts-jest transform cannot import directly) against synthetic
 * diffs, and pins BOTH directions: the defensively-defaulted call site is
 * clean, and an unguarded read is still reported.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

const RULE_PATH = path.resolve(
  __dirname,
  '../../../../scripts/ci/impact-rules/new-env-var-requires-workflow-binding.mjs',
);

type Finding = { rule: string; raw?: { missing_env_vars?: string[] } };

/** Run the rule's real check() under Node's native ESM loader. */
function runRule(addedLines: string[]): Finding[] {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'env-binding-rule-'));
  const file = 'services/gateway/src/services/thing.ts';
  const diff = [
    `diff --git a/${file} b/${file}`,
    'index 0000000..1111111 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,0 +1,99 @@',
    ...addedLines.map((l) => `+${l}`),
    '',
  ].join('\n');

  const driver = [
    `import { check } from ${JSON.stringify(RULE_PATH)};`,
    `const findings = await check({ diff: ${JSON.stringify(diff)}, repoRoot: ${JSON.stringify(repoRoot)} });`,
    'process.stdout.write(JSON.stringify(findings));',
  ].join('\n');

  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', driver], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    return JSON.parse(out) as Finding[];
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

function missingVars(lines: string[]): string[] {
  const findings = runRule(lines);
  if (findings.length === 0) return [];
  return findings[0].raw?.missing_env_vars ?? [];
}

describe('VTID-04287: defensive env fallback satisfies new-env-var-requires-workflow-binding', () => {
  beforeAll(() => {
    expect(fs.existsSync(RULE_PATH)).toBe(true);
  });

  it('accepts the exact harness-shoot.js call sites this finding was opened for', () => {
    // docs/validation/VTID-04282/outputs/harness-shoot.js:5-7 verbatim.
    expect(
      missingVars([
        "const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18482';",
        'const OUT = process.env.OUT_DIR || __dirname;',
        "const TABS = (process.env.TABS || 'live,scanners').split(',');",
      ]),
    ).toEqual([]);
  });

  it('accepts the `??` form the rule itself recommends', () => {
    expect(
      missingVars([
        "const url = process.env.HARNESS_URL ?? 'http://127.0.0.1:18482';",
        "const out = process.env.OUT_DIR ?? './out';",
        "const tabs = process.env.TABS ?? '2';",
      ]),
    ).toEqual([]);
  });

  it('accepts a numeric / boolean / member-expression fallback', () => {
    expect(
      missingVars([
        'const width = process.env.OUT_DIR_WIDTH ?? 2;',
        'const on = process.env.HARNESS_ENABLED || false;',
        'const p = process.env.OUT_DIR_PATH || path.sep;',
      ]),
    ).toEqual([]);
  });

  it('still reports an unguarded read — the gate keeps its teeth', () => {
    expect(
      missingVars(["const BASE = process.env.HARNESS_URL;"]),
    ).toEqual(['HARNESS_URL']);
  });

  it('still reports `|| undefined`, which is not a fallback at all', () => {
    expect(
      missingVars(['const BASE = process.env.HARNESS_URL || undefined;']),
    ).toEqual(['HARNESS_URL']);
  });

  it('still reports chaining onto another env read, which may be unset too', () => {
    expect(
      missingVars(['const BASE = process.env.HARNESS_URL || process.env.ALT_HARNESS_URL;']),
    ).toEqual(['HARNESS_URL', 'ALT_HARNESS_URL']);
  });

  it('still reports a call as the fallback — it may itself return undefined', () => {
    expect(
      missingVars(['const BASE = process.env.HARNESS_URL ?? resolveHarnessUrl();']),
    ).toEqual(['HARNESS_URL']);
  });

  it('does not let one guarded reference launder an unguarded read of the same var', () => {
    // Both reads of the same var in one diff: the unguarded one must survive.
    expect(
      missingVars([
        "const a = process.env.HARNESS_URL ?? 'http://127.0.0.1:18482';",
        'const b = process.env.HARNESS_URL;',
      ]),
    ).toEqual(['HARNESS_URL']);
  });

  it('still reports a var bound in neither config nor a fallback', () => {
    expect(missingVars(['const x = process.env.TOTALLY_UNBOUND_VAR;'])).toEqual([
      'TOTALLY_UNBOUND_VAR',
    ]);
  });
});
