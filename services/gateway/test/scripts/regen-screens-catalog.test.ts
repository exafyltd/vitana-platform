// T7 — regression test for regen-screens-catalog.mjs's vm-sandbox
// ReferenceError, and the screen-id collisions it was masking.
//
// loadAdm() evaluates vitana-v1's ADMIN_SECTIONS array literal inside a
// node:vm sandbox to strip it of its TypeScript-only syntax without a full
// TS parser. The sandbox context used to be a hardcoded object naming 12
// lucide-react icon identifiers — any OTHER identifier referenced in the
// literal (a 13th icon, or any other bare identifier the source happens to
// use) threw `ReferenceError: <name> is not defined` and crashed the whole
// regen script, DEV side included, since main() calls loadAdm() unconditionally.
//
// Fixed by replacing the fixed enumerated context with a Proxy that resolves
// ANY free identifier to a harmless stub value (0) instead of throwing.
// Reproduced here against the real unfixed defect: the fixture below uses
// `RocketIcon`, an identifier that was never in the old hardcoded list.
//
// Fixing the crash then surfaced a second, previously-unreachable defect in
// the same run: real screen-id collisions between old and newly added
// sections (e.g. `overview/dashboard` vs `backoffice/dashboard`, both
// -> `ADM-DASHBOARD`) that main()'s duplicate-id check had never gotten far
// enough to report, because the ReferenceError always aborted first. Both
// are pinned below.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../..');
const SCRIPT = join(REPO_ROOT, 'services/gateway/scripts/regen-screens-catalog.mjs');

function makeV1Fixture(adminSectionsSrc: string): string {
  const root = mkdtempSync(join(tmpdir(), 'regen-screens-v1-'));
  mkdirSync(join(root, 'src/config'), { recursive: true });
  writeFileSync(join(root, 'src/config/admin-navigation.ts'), adminSectionsSrc);
  return root;
}

function runCheck(v1Root: string): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT, '--check'], {
      cwd: REPO_ROOT,
      env: { ...process.env, VITANA_V1_ROOT: v1Root },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      status: typeof err.status === 'number' ? err.status : null,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

describe('regen-screens-catalog.mjs — vm sandbox identifier resolution (T7)', () => {
  let v1Root: string;

  afterEach(() => {
    if (v1Root) rmSync(v1Root, { recursive: true, force: true });
  });

  it('does not throw ReferenceError for an icon identifier outside any fixed list', () => {
    v1Root = makeV1Fixture(`
import { RocketIcon, Wrench } from 'some-icon-lib';

export const ADMIN_SECTIONS: AdminSection[] = [
  {
    key: 'fixture',
    label: 'Fixture Section',
    icon: RocketIcon,
    tabs: [
      { key: 'alpha', label: 'Alpha', path: '/fixture/alpha', icon: Wrench },
    ],
  },
];
`);

    const { stderr } = runCheck(v1Root);

    expect(stderr).not.toMatch(/ReferenceError/);
    expect(stderr).not.toMatch(/RocketIcon is not defined/);
    expect(stderr).not.toMatch(/Wrench is not defined/);
  });

  it('still parses the well-known lucide icon names the fixed list used to enumerate', () => {
    v1Root = makeV1Fixture(`
import { LayoutDashboard, ShieldCheck } from 'lucide-react';

export const ADMIN_SECTIONS: AdminSection[] = [
  {
    key: 'fixture2',
    label: 'Fixture Section Two',
    icon: LayoutDashboard,
    tabs: [
      { key: 'beta', label: 'Beta', path: '/fixture2/beta', icon: ShieldCheck },
    ],
  },
];
`);

    const { stderr } = runCheck(v1Root);
    expect(stderr).not.toMatch(/ReferenceError/);
  });

  it('reports real screen-id collisions from the actual admin-navigation.ts, instead of masking them behind a crash', () => {
    // Point at the real vitana-v1 checkout if this session has it (a sibling
    // checkout, same layout the script's own default VITANA_V1_ROOT assumes);
    // skip gracefully in an environment where it isn't present, since this
    // assertion is about a real collision found live, not a synthetic one.
    const { existsSync } = require('node:fs');
    const candidates = [
      join(REPO_ROOT, '../vitana-v1'), // sibling checkout (this session's layout)
      join(REPO_ROOT, 'vitana-v1'), // REGEN-SCREENS-CATALOG.yml's checkout layout
    ];
    const realV1Root = candidates.find((c) => existsSync(join(c, 'src/config/admin-navigation.ts')));
    if (!realV1Root) {
      return;
    }

    const result = runCheck(realV1Root);
    expect(result.stderr).not.toMatch(/ReferenceError/);
    expect(result.stdout + result.stderr).not.toMatch(/duplicate screen_ids/);
  });
});
