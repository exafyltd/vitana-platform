/**
 * VTID-04273: secret-exposure-scanner-v1 false-positive fixes.
 *
 * Live evidence: `autopilot_recommendations` row `3d729613...` ("Hardcoded
 * secret in AURORA-I18N-INTEGRATION.yml") was a `[rollup]` flagging 8 files
 * with the same "URL with embedded credentials appears hardcoded" message.
 * Read every one of them directly — all 8 are false positives, of two
 * shapes the scanner's regex had no way to tell apart from a real leak:
 *
 *   1. `${...}` / a bare `$VAR` between the `:` and the `@` — the URL is
 *      being CONSTRUCTED from a variable at runtime (a TS template literal
 *      or a bash expansion), so there is no literal secret in the source at
 *      all. Real hits: `services/gateway/src/services/autopilot-agent/
 *      agent-workspace.ts:55` (`https://x-access-token:${token}@github.com/
 *      ...`) and `scripts/aws/setup-operator-sql-readonly-secret.sh:88`
 *      (`postgresql://${USER_NAME}:${ENC_PASS}@${READER}:5432/...`).
 *   2. `@127.0.0.1` / `@localhost` — a loopback host. Whatever precedes it
 *      is reachable only from the machine that already holds it (the CI
 *      runner's own ephemeral Postgres service container), never a real
 *      exposure. Real hits: `.github/workflows/AURORA-I18N-INTEGRATION.yml:60`
 *      and `.github/workflows/CICDL-GATEWAY-CI.yml:69`
 *      (`postgres(ql)://postgres:postgres@(127.0.0.1|localhost):5432/...`),
 *      plus two docs quoting the same snippet.
 *
 * A third file (`docs/validation/VTID-03798/outputs/before-fix-live-staging-
 * evidence.txt:24`) already redacts the password as `***` — added as a
 * global placeholder hint, since a masked preview carries no secret either.
 *
 * This is a scanner-source fix, not 8 file annotations, so the same
 * false-positive class does not keep recurring on the next scan (the
 * actual "does this ever converge to zero" question CLAUDE.md's Dev
 * Autopilot continuity loop depends on).
 *
 * `scripts/ci/scanners/*.mjs` is deliberately zero-dep, plain ESM (its own
 * header: "so GitHub Actions can run scans without an npm install") and has
 * no jest harness of its own. Jest's own module system (CJS/ts-jest here)
 * cannot `require()` or dynamically `import()` a bare `.mjs` file without a
 * transform for it — attempted directly and confirmed it throws
 * `SyntaxError: Cannot use import statement outside a module`, since Jest
 * intercepts `import()` too, not just `require()`. So this test spawns a
 * real, separate Node process to run the scanner via a real dynamic
 * `import()` under Node's own native ESM loader — the exact mechanism the
 * CI scan workflow itself uses — and reads its JSON stdout, rather than
 * mocking or reimplementing the regex logic.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

const SCANNER_PATH = path.resolve(__dirname, '../../../../scripts/ci/scanners/secret-exposure.mjs');

type Signal = { file_path: string; message: string };

describe('VTID-04273: secret-exposure-scanner-v1 false positives', () => {
  let tmpDir: string;

  beforeAll(() => {
    expect(fs.existsSync(SCANNER_PATH)).toBe(true);
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-exposure-test-'));
    for (const dir of ['.github', 'scripts', 'services', 'docs']) {
      fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runScanner(): Signal[] {
    const driver = [
      `import { run } from ${JSON.stringify(SCANNER_PATH)};`,
      `const signals = await run({ repoRoot: ${JSON.stringify(tmpDir)} });`,
      `process.stdout.write(JSON.stringify(signals));`,
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', driver], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    return JSON.parse(out) as Signal[];
  }

  function scanFile(relDir: string, relFile: string, content: string): Signal[] {
    fs.writeFileSync(path.join(tmpDir, relDir, relFile), content);
    return runScanner();
  }

  it('does not flag the CI service-container default at a loopback host (127.0.0.1)', () => {
    const signals = scanFile(
      '.github',
      'wf.yml',
      'env:\n  URL: postgres://postgres:postgres@127.0.0.1:5432/aurora_test?sslmode=disable\n'
    );
    expect(signals).toEqual([]);
  });

  it('does not flag the same default at "localhost"', () => {
    const signals = scanFile(
      '.github',
      'wf2.yml',
      'echo "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/vitana_test?schema=public" >> $GITHUB_ENV\n'
    );
    expect(signals).toEqual([]);
  });

  it('does not flag a bash-interpolated URL built entirely from variables', () => {
    const signals = scanFile(
      'scripts',
      's.sh',
      'URL="postgresql://${USER_NAME}:${ENC_PASS}@${READER}:5432/${DB_NAME}?sslmode=require"\n'
    );
    expect(signals).toEqual([]);
  });

  it('does not flag a TS template literal building a URL from a runtime parameter', () => {
    const signals = scanFile(
      'services',
      'a.ts',
      'function remoteUrl(t: string) { return `https://x-access-token:${t}@github.com/org/repo.git`; }\n'
    );
    expect(signals).toEqual([]);
  });

  it('does not flag an already-redacted (***) preview', () => {
    const signals = scanFile(
      'docs',
      'evidence.txt',
      'target: postgresql://vitana_admin:***@vitana-rds-proxy-prod.proxy-abc123.eu-central-1.rds.amazonaws.com:5432/vitana\n'
    );
    expect(signals).toEqual([]);
  });

  it('STILL flags a genuine, literal, non-loopback, non-redacted embedded credential', () => {
    const signals = scanFile(
      'services',
      'real-leak.ts',
      'const DB = "postgres://admin:SuperSecretPass123@db.prod.acmecorp.io:5432/app";\n'
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].file_path).toBe('services/real-leak.ts');
    expect(signals[0].message).toContain('URL with embedded credentials');
  });

  it('still flags a genuine credential even when the host looks like a bare IP that is not loopback', () => {
    const signals = scanFile(
      'services',
      'real-leak-ip.ts',
      'const DB = "postgres://admin:SuperSecretPass123@10.0.4.55:5432/app";\n'
    );
    expect(signals).toHaveLength(1);
  });

  it('unrelated secret patterns (e.g. an Anthropic key) are unaffected by this change', () => {
    const signals = scanFile(
      'services',
      'anthropic.ts',
      'const KEY = "sk-ant-abcdefghijklmnopqrstuvwxyz1234567890";\n'
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].message).toContain('Anthropic API key');
  });
});
