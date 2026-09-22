/**
 * VTID-04296 — path-to-regexp ReDoS (GHSA-9wv6-86v2-598j / CVE-2024-45296).
 *
 * `npm-audit-scanner-v1` flagged `path-to-regexp` against
 * `services/worker-runner/package.json`. It is NOT a direct dependency — it
 * arrives transitively through `express`, which uses it for route matching, so
 * a crafted multi-parameter route reaches the vulnerable code path.
 *
 * This suite reads worker-runner's manifest and lock from the repo root and
 * pins BOTH halves of the fix. Pinning only the manifest is the exact failure
 * VTID-04245 already documented for the gateway: a `package.json` that "reads
 * as patched" while the lockfile still resolves the vulnerable version.
 *
 *   1. `dependencies.express` must be `>=4.21.0`.
 *   2. `package-lock.json` must actually RESOLVE `path-to-regexp` at
 *      `>=0.1.13`, the patched release.
 *
 * Express 4.22.x declares `path-to-regexp: ~0.1.12` — a range that ADMITS
 * 0.1.13 — so the real fix is the lock resolution, not a different express
 * major or an override.
 *
 * WHY THIS LIVES UNDER services/gateway/test/: worker-runner installs with npm
 * (`Dockerfile` and TEST-SUITE.yml both run `npm ci`) and its own jest binary
 * is only present after that install. The gateway suite is the tree that runs
 * unconditionally in CI, so the guard lives where it actually executes; it
 * reaches across to the service under guard by path. worker-runner's own
 * tsconfig excludes test files either way, so placement cannot affect its
 * build output.
 */

import * as fs from 'fs';
import * as path from 'path';

const SERVICE_ROOT = path.resolve(__dirname, '..', '..', 'worker-runner');
const pkg = JSON.parse(fs.readFileSync(path.join(SERVICE_ROOT, 'package.json'), 'utf8'));
const npmLock = JSON.parse(fs.readFileSync(path.join(SERVICE_ROOT, 'package-lock.json'), 'utf8'));

/** Express release that stopped pinning the vulnerable path-to-regexp. */
const EXPRESS_FLOOR = '4.21.0';
/** First patched path-to-regexp 0.1.x release. */
const PATH_TO_REGEXP_FLOOR = '0.1.13';

function parseSemver(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) throw new Error(`not a semver: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function gte(a: string, b: string): boolean {
  const [a1, a2, a3] = parseSemver(a);
  const [b1, b2, b3] = parseSemver(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 >= b3;
}

/** Every version the npm lockfile resolves for a package (any nesting). */
function npmResolved(name: string): string[] {
  const out: string[] = [];
  for (const [p, entry] of Object.entries<any>(npmLock.packages || {})) {
    if (p === `node_modules/${name}` || p.endsWith(`/node_modules/${name}`)) out.push(entry.version);
  }
  return out;
}

/** The lock's own copy of the root manifest (must mirror package.json). */
const lockRoot = npmLock.packages?.[''] ?? {};

describe('VTID-04296: worker-runner express + path-to-regexp floors', () => {
  it(`express is declared at >=${EXPRESS_FLOOR} in package.json`, () => {
    const spec: string | undefined = pkg.dependencies?.express;
    expect(spec).toBeDefined();

    const m = /(\d+)\.(\d+)\.(\d+)/.exec(spec!);
    expect(m).not.toBeNull();
    const declared = `${m![1]}.${m![2]}.${m![3]}`;

    // A caret range's lower bound IS its floor; a bare `*`/`>=x` still parses to
    // the first triple, which is the conservative reading we want.
    expect({ spec, ok: gte(declared, EXPRESS_FLOOR) }).toEqual({ spec, ok: true });
  });

  it('the lockfile root entry mirrors the package.json express range', () => {
    // `npm ci` fails on a lock/manifest mismatch, so drift here is a hard
    // install failure, not just a stale lock.
    expect(lockRoot.dependencies?.express).toBe(pkg.dependencies?.express);
  });

  it(`package-lock.json resolves express at >=${EXPRESS_FLOOR}`, () => {
    const versions = npmResolved('express');
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      expect({ v, ok: gte(v, EXPRESS_FLOOR) }).toEqual({ v, ok: true });
    }
  });

  it(`package-lock.json resolves path-to-regexp at >=${PATH_TO_REGEXP_FLOOR} everywhere`, () => {
    // This is the actual CVE. Express 4.22.x asks for `~0.1.12`, which permits
    // 0.1.13 — so a lock that resolves 0.1.12 is a real, still-vulnerable state.
    const versions = npmResolved('path-to-regexp');
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      expect({ v, ok: gte(v, PATH_TO_REGEXP_FLOOR) }).toEqual({ v, ok: true });
    }
  });

  it('express still declares a range that admits the patched path-to-regexp', () => {
    // Guards the fix against a future express pin that re-narrows to a range
    // excluding 0.1.13 (e.g. an exact `0.1.12` pin), which would silently
    // reintroduce the advisory even while `express` itself reads as new enough.
    //
    // Deliberately NOT a full semver-range solver: it asserts the shape (a
    // range, not an exact pin) and that the range's floor does not exceed the
    // patched release. Express's own 0.1.x line is the case that matters, and
    // the decisive assertion remains the resolved-version one above.
    const expressEntry = (npmLock.packages || {})['node_modules/express'];
    expect(expressEntry).toBeDefined();

    const range: string | undefined = expressEntry.dependencies?.['path-to-regexp'];
    expect(range).toBeDefined();
    expect(range!).toMatch(/^[\^~]|^>=?|^\d+\.\d+\.x|^\*/);

    const m = /(\d+)\.(\d+)\.(\d+)/.exec(range!);
    expect(m).not.toBeNull();
    expect(gte(PATH_TO_REGEXP_FLOOR, `${m![1]}.${m![2]}.${m![3]}`)).toBe(true);
  });
});
