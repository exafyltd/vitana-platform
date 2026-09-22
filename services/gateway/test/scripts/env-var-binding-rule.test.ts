/**
 * VTID-04287: `new-env-var-requires-workflow-binding` must be satisfiable by
 * the remedy it recommends.
 *
 * Live finding: 3 vars (`HARNESS_URL`, `OUT_DIR`, `TABS`) reported as "no
 * binding in any workflow / deploy config / .env.example". Every one of them
 * was already defensive at its call site, in
 * `docs/validation/VTID-04282/outputs/harness-shoot.js`:
 *
 *     const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18482';
 *     const OUT  = process.env.OUT_DIR      || __dirname;
 *     const TABS = (process.env.TABS        || 'live,scanners,...').split(',');
 *
 * The rule's own suggested_action names exactly that as remedy (c) — "if it's
 * truly optional, add a defensive `process.env.X ?? 'default'` at the call
 * site" — yet the implementation only ever tested the config blob, so doing
 * what the finding said left the finding in place forever. A warning that
 * cannot be cleared by following its own advice is how a gate gets laundered
 * (VTID-03696: an unsatisfiable gate is worse than no gate).
 *
 * The fix is diff-scoped: an added read is handled when the added lines of
 * that file carry a fallback or a null check for it. A bare added read is
 * still flagged, and an unrelated guard elsewhere in the file does not
 * silence it — otherwise this becomes the rubber stamp the rule exists to
 * avoid.
 *
 * `.mjs` impact rules have no jest transform and Jest's `import()` cannot
 * load a bare `.mjs` module (see secret-exposure-scanner.test.ts for the
 * measurement), so this spawns a real Node process and uses the repo's own
 * ESM loader — the same mechanism the impact-scan driver uses.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

const RULE_PATH = path.resolve(
  __dirname,
  '../../../../scripts/ci/impact-rules/new-env-var-requires-workflow-binding.mjs',
);

type Finding = { rule: string; message: string; raw?: { missing_env_vars: string[] } };

/** Minimal unified diff so `extractAddedLines` sees added lines for one file. */
function diffFor(file: string, addedLines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    'index 0000000..1111111 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +1,${addedLines.length} @@`,
    ...addedLines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

function runCheck(diff: string, repoRoot: string): Finding[] {
  const driver = [
    `import { check } from ${JSON.stringify(RULE_PATH)};`,
    `const findings = await check({ diff: ${JSON.stringify(diff)}, repoRoot: ${JSON.stringify(repoRoot)} });`,
    `process.stdout.write(JSON.stringify(findings));`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', driver], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return JSON.parse(out) as Finding[];
}

function runHasDefensiveDefault(text: string, varName: string): boolean {
  const driver = [
    `import { hasDefensiveDefault } from ${JSON.stringify(RULE_PATH)};`,
    `process.stdout.write(String(hasDefensiveDefault(${JSON.stringify(text)}, ${JSON.stringify(varName)})));`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', driver], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return out.trim() === 'true';
}

function runHasGuardedBinding(lines: string[], varName: string): boolean {
  const driver = [
    `import { hasGuardedBinding } from ${JSON.stringify(RULE_PATH)};`,
    `process.stdout.write(String(hasGuardedBinding(${JSON.stringify(lines)}, ${JSON.stringify(varName)})));`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', driver], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return out.trim() === 'true';
}

/** Vars the rule reports as missing across all of its findings. */
function missingVars(findings: Finding[]): string[] {
  return findings.flatMap((f) => f.raw?.missing_env_vars ?? []);
}

describe('VTID-04287: new-env-var-requires-workflow-binding — remedy (c) is implementable', () => {
  let tmpDir: string;

  beforeAll(() => {
    expect(fs.existsSync(RULE_PATH)).toBe(true);
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-binding-rule-test-'));
    fs.mkdirSync(path.join(tmpDir, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'services', 'gateway'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('hasDefensiveDefault', () => {
    it.each([
      ["const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18482';", 'falsy default (||)'],
      ["const d = process.env.OUT_DIR ?? './out';", 'nullish default (??)'],
      ["const x = process.env.TABS && parseInt(process.env.TABS, 10);", 'short-circuit (&&)'],
      ['if (!process.env.HARNESS_URL) return;', 'negated guard'],
      ['if (process.env.HARNESS_URL === undefined) return;', '=== undefined'],
      ['if (undefined === process.env.HARNESS_URL) return;', 'undefined === (reversed)'],
      ['if (process.env.OUT_DIR == null) return;', '== null'],
      ['if (process.env.TABS !== undefined) use(process.env.TABS);', '!== undefined'],
    ])('accepts %s (%s)', (text, _label) => {
      const varName = /process\.env\.([A-Z0-9_]+)/.exec(text)![1];
      expect(runHasDefensiveDefault(text, varName)).toBe(true);
    });

    it.each([
      ['const BASE = process.env.HARNESS_URL;'],
      ['const url = `${process.env.HARNESS_URL}/command-hub/`;'],
      ['export const TABS = process.env.TABS;'],
    ])('rejects a bare read: %s', (text) => {
      const varName = /process\.env\.([A-Z0-9_]+)/.exec(text)![1];
      expect(runHasDefensiveDefault(text, varName)).toBe(false);
    });

    it('does not treat a fallback for a DIFFERENT var as covering this one', () => {
      const text = "const a = process.env.OUT_DIR ?? './out';\nconst b = process.env.HARNESS_URL;";
      expect(runHasDefensiveDefault(text, 'HARNESS_URL')).toBe(false);
      expect(runHasDefensiveDefault(text, 'OUT_DIR')).toBe(true);
    });

    it('does not span a newline to find a fallback', () => {
      // The read is bare; the `??` on the next line belongs to another value.
      const text = 'const a = process.env.HARNESS_URL;\nconst b = a ?? "x";';
      expect(runHasDefensiveDefault(text, 'HARNESS_URL')).toBe(false);
    });
  });

  describe('hasGuardedBinding (multi-line guard, the services/gateway/src/env.ts shape)', () => {
    it('accepts a local binding that is null-checked on a following line', () => {
      const lines = [
        'const url = process.env.SUPABASE_URL;',
        'if (!url) return null;',
      ];
      expect(runHasGuardedBinding(lines, 'SUPABASE_URL')).toBe(true);
    });

    it('accepts the === undefined form on the local name', () => {
      const lines = [
        'const token = process.env.OPERATOR_MACHINE_AUTH_TOKEN;',
        'if (token === undefined) return res.status(503).json({ ok: false });',
      ];
      expect(runHasGuardedBinding(lines, 'OPERATOR_MACHINE_AUTH_TOKEN')).toBe(true);
    });

    it('rejects a bound local that is never checked', () => {
      const lines = [
        'const token = process.env.OPERATOR_MACHINE_AUTH_TOKEN;',
        'return call(token);',
      ];
      expect(runHasGuardedBinding(lines, 'OPERATOR_MACHINE_AUTH_TOKEN')).toBe(false);
    });

    it('rejects a null check on a DIFFERENT local than the env read', () => {
      const lines = [
        'const token = process.env.OPERATOR_MACHINE_AUTH_TOKEN;',
        'const other = compute();',
        'if (!other) return null;',
      ];
      expect(runHasGuardedBinding(lines, 'OPERATOR_MACHINE_AUTH_TOKEN')).toBe(false);
    });
  });

  describe('check()', () => {
    it('does NOT flag the VTID-04282 harness-shoot.js reads — all three fall back', () => {
      const diff = diffFor('docs/validation/VTID-04282/outputs/harness-shoot.js', [
        "const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18482';",
        'const OUT = process.env.OUT_DIR || __dirname;',
        "const TABS = (process.env.TABS || 'live,scanners').split(',');",
      ]);
      const findings = runCheck(diff, tmpDir);
      expect(missingVars(findings)).toEqual([]);
    });

    it('still flags a bare added read with no binding and no fallback', () => {
      const diff = diffFor('services/gateway/src/thing.ts', [
        'const truthy = process.env.SOME_BRAND_NEW_VAR;',
      ]);
      const findings = runCheck(diff, tmpDir);
      expect(missingVars(findings)).toEqual(['SOME_BRAND_NEW_VAR']);
      expect(findings[0].rule).toBe('new-env-var-requires-workflow-binding');
    });

    it('accepts a var bound to a local and null-checked on the next line', () => {
      const diff = diffFor('services/gateway/src/thing.ts', [
        'const token = process.env.OPERATOR_MACHINE_AUTH_TOKEN;',
        'if (!token) return res.status(503).json({ ok: false });',
      ]);
      expect(missingVars(runCheck(diff, tmpDir))).toEqual([]);
    });

    it('is not silenced by an unrelated guard elsewhere in the same added block', () => {
      // The `??` belongs to a different var; the bare read must still surface.
      const diff = diffFor('services/gateway/src/thing.ts', [
        'const bare = process.env.SOME_BRAND_NEW_VAR;',
        "const other = process.env.ANOTHER_NEW_VAR ?? 'x';",
      ]);
      const findings = runCheck(diff, tmpDir);
      expect(missingVars(findings)).toContain('SOME_BRAND_NEW_VAR');
    });

    it('is not silenced by a fallback for the SAME var on an unrelated line', () => {
      // A genuinely optional read of X does not make a bare read of X safe.
      const diff = diffFor('services/gateway/src/thing.ts', [
        'const bare = process.env.SOME_BRAND_NEW_VAR;',
        "const optional = process.env.SOME_BRAND_NEW_VAR ?? 'fallback';",
      ]);
      const findings = runCheck(diff, tmpDir);
      expect(missingVars(findings)).toContain('SOME_BRAND_NEW_VAR');
    });

    it('accepts a var that IS bound in a deploy config', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.github', 'workflows', 'deploy.yml'),
        'env:\n  BOUND_NEW_VAR: ${{ secrets.BOUND_NEW_VAR }}\n',
      );
      const diff = diffFor('services/gateway/src/thing.ts', [
        'const x = process.env.BOUND_NEW_VAR;',
      ]);
      expect(missingVars(runCheck(diff, tmpDir))).toEqual([]);
    });

    it('ignores test files (they are not deployment surfaces)', () => {
      const diff = diffFor('services/gateway/test/thing.test.ts', [
        'const x = process.env.SOME_BRAND_NEW_VAR;',
      ]);
      expect(runCheck(diff, tmpDir)).toEqual([]);
    });

    it('ignores vars on the ALWAYS_BOUND allowlist', () => {
      const diff = diffFor('services/gateway/src/thing.ts', [
        'const port = process.env.PORT;',
        'const env = process.env.NODE_ENV;',
      ]);
      expect(runCheck(diff, tmpDir)).toEqual([]);
    });

    // The rule's own header documents the shapes it looks for, so it contains
    // quoted `process.env.<VAR>` reads. Treated as added lines, every one must
    // come out handled — otherwise the rule flags its own source, the exact
    // self-match class fixed for todo-scanner-v1 in VTID-04275.
    it('does not flag its own source (self-match)', () => {
      const ownSource = fs.readFileSync(RULE_PATH, 'utf8').split('\n');
      const diff = diffFor('scripts/ci/impact-rules/new-env-var-requires-workflow-binding.mjs', ownSource);
      expect(missingVars(runCheck(diff, tmpDir))).toEqual([]);
    });
  });
});
