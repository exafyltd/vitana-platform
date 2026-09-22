/**
 * VTID-04245 — the three npm-audit floors the Dev Autopilot agent could not
 * apply itself (its `run_check` surface has no package manager; every attempt
 * on the finding exhausted the turn cap reading pnpm-lock.yaml — VTID-04237).
 *
 * The bump is a manual dependency change: express-rate-limit ^8.2.2,
 * @modelcontextprotocol/sdk ^1.24.0, and a repo-level override that forces the
 * transitive @grpc/grpc-js to >=1.14.4. This suite pins the declared floors in
 * package.json AND the versions the lockfiles actually resolve, so a future
 * `npm install` / `pnpm install` cannot silently regress below the audit
 * threshold while package.json still reads as patched.
 */

import * as fs from 'fs';
import * as path from 'path';

const GATEWAY = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(GATEWAY, 'package.json'), 'utf8'));
const pnpmLock = fs.readFileSync(path.join(GATEWAY, 'pnpm-lock.yaml'), 'utf8');
const npmLock = JSON.parse(fs.readFileSync(path.join(GATEWAY, 'package-lock.json'), 'utf8'));

function parseSemver(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
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

/** Every version the pnpm lockfile resolves for a package (any importer). */
function pnpmResolved(name: string): string[] {
  const re = new RegExp(`^  '?${name.replace(/[/@.]/g, (c) => `\\${c}`)}@(\\d+\\.\\d+\\.\\d+[^'\\s:]*)'?:`, 'gm');
  const out: string[] = [];
  for (const m of pnpmLock.matchAll(re)) out.push(m[1]);
  return out;
}

/** Every version the npm lockfile resolves for a package (any nesting). */
function npmResolved(name: string): string[] {
  const out: string[] = [];
  for (const [p, entry] of Object.entries<any>(npmLock.packages || {})) {
    if (p === `node_modules/${name}` || p.endsWith(`/node_modules/${name}`)) out.push(entry.version);
  }
  return out;
}

const FLOORS: Array<{ name: string; floor: string; direct: boolean }> = [
  { name: 'express-rate-limit', floor: '8.2.2', direct: true },
  { name: '@modelcontextprotocol/sdk', floor: '1.24.0', direct: true },
  { name: '@grpc/grpc-js', floor: '1.14.4', direct: false },
];

describe('VTID-04245: npm-audit floors are declared in package.json', () => {
  it('express-rate-limit is a direct dependency at ^8.2.2 or later', () => {
    expect(pkg.dependencies['express-rate-limit']).toMatch(/^\^?8\.(\d+)\.(\d+)/);
    const [, minor, patch] = /^\^?8\.(\d+)\.(\d+)/.exec(pkg.dependencies['express-rate-limit'])!;
    expect(gte(`8.${minor}.${patch}`, '8.2.2')).toBe(true);
  });

  it('@modelcontextprotocol/sdk is a direct dependency at ^1.24.0 or later', () => {
    expect(pkg.dependencies['@modelcontextprotocol/sdk']).toMatch(/^\^?1\.(\d+)\.(\d+)/);
    const [, minor, patch] = /^\^?1\.(\d+)\.(\d+)/.exec(pkg.dependencies['@modelcontextprotocol/sdk'])!;
    expect(gte(`1.${minor}.${patch}`, '1.24.0')).toBe(true);
  });

  it('@grpc/grpc-js is forced to >=1.14.4 for BOTH package managers (npm overrides + pnpm.overrides)', () => {
    // The gateway image installs with npm (Dockerfile) while CI/dev use pnpm —
    // an override present in only one of the two would patch only one of them.
    expect(pkg.overrides?.['@grpc/grpc-js']).toBe('>=1.14.4');
    expect(pkg.pnpm?.overrides?.['@grpc/grpc-js']).toBe('>=1.14.4');
  });
});

describe('VTID-04245: both lockfiles resolve every floor', () => {
  for (const { name, floor } of FLOORS) {
    it(`pnpm-lock.yaml resolves ${name} at >=${floor} everywhere it appears`, () => {
      const versions = pnpmResolved(name);
      expect(versions.length).toBeGreaterThan(0);
      for (const v of versions) expect({ name, v, ok: gte(v, floor) }).toEqual({ name, v, ok: true });
    });

    it(`package-lock.json resolves ${name} at >=${floor} everywhere it appears`, () => {
      const versions = npmResolved(name);
      expect(versions.length).toBeGreaterThan(0);
      for (const v of versions) expect({ name, v, ok: gte(v, floor) }).toEqual({ name, v, ok: true });
    });
  }
});

describe('VTID-04245: the MCP SDK 0.x -> 1.x major is inert for the gateway', () => {
  it('no gateway source file imports @modelcontextprotocol/sdk (the bump cannot break runtime code)', () => {
    // VTID-04261: match real import/require statements, not a bare substring.
    // The floor-policy module (src/lib/dependency-floor-policy.ts) NAMES this
    // package as data — a policy row must not read as a code dependency, or
    // documenting a floor would falsely fail this inert-major check.
    const src = path.join(GATEWAY, 'src');
    const IMPORT_RE = /(?:from|require\s*\(|import\s*\(?)\s*['"]@modelcontextprotocol\/sdk/;
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|js|mjs|cjs)$/.test(e.name) && IMPORT_RE.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk(src);
    expect(hits).toEqual([]);
  });
});
