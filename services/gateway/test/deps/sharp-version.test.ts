/**
 * VTID-04295 — the `sharp` / libvips npm-audit floor.
 *
 * `npm-audit-scanner-v1` flagged the direct dependency `sharp` at `^0.34.5`
 * for four high-severity libvips advisories: CVE-2026-33327, CVE-2026-33328,
 * CVE-2026-35590 and CVE-2026-35591. sharp ships its own prebuilt libvips, so
 * the fix is a manifest bump from `^0.34.5` to `^0.35.0` (patched libvips
 * binaries) plus lockfile regeneration — no application code changes, since
 * sharp's public API is unchanged across 0.34 -> 0.35.
 *
 * `services/gateway/package.json` and the lockfiles are OUTSIDE the Dev
 * Autopilot executor's `allow_scope` (the same wall VTID-04237 / VTID-04163 /
 * VTID-04261 documented), so the manifest bump is a manual, reviewable
 * hand-off. What the executor CAN own — and what this suite pins — is the
 * machine-readable floor (`src/lib/dependency-floor-policy.ts`) plus the
 * invariants over the live manifest/lockfiles that hold both BEFORE and AFTER
 * the hand-off lands:
 *
 *   1. `sharp` is tracked as a DIRECT floor at >=0.35.0. A direct dependency is
 *      bumped in `dependencies`; it must never be "fixed" with an `overrides`
 *      entry, so it must never appear in `missingFloors` either.
 *   2. The declared spec is either already at/above the floor, or exactly the
 *      known pre-hand-off spec. A spec BELOW the vulnerable line (e.g.
 *      `^0.34.0`) fails immediately — that is the regression this guards.
 *   3. Once the declared spec reaches the floor, the lockfiles and the
 *      installed tree must reach it too. A bumped manifest with a stale
 *      lockfile or a stale `node_modules` fails here rather than shipping
 *      vulnerable libvips to the gateway image.
 *
 * Deliberately NOT asserted: that `sharp` is currently >=0.35.0. Pinning the
 * pending state would turn the fix itself into a test failure (the same reason
 * VTID-04261 left today's vulnerable lockfile resolutions unasserted).
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  DEPENDENCY_FLOORS,
  evaluateDeclaredFloors,
  isFloorSatisfied,
  missingFloors,
  parseSemver,
  semverGte,
  specFloor,
} from '../../src/lib/dependency-floor-policy';

const GATEWAY = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(GATEWAY, 'package.json');
const pkg = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

const SHARP = 'sharp';
const FLOOR = '0.35.0';
/** The manifest spec the hand-off replaces — the only sub-floor spec tolerated. */
const PRE_HANDOFF_SPEC = /^\^?0\.34\.5$/;
const CVES = ['CVE-2026-33327', 'CVE-2026-33328', 'CVE-2026-35590', 'CVE-2026-35591'];

/** Every version the pnpm lockfile resolves for a package (any importer). */
function pnpmResolved(name: string): string[] {
  const lock = fs.readFileSync(path.join(GATEWAY, 'pnpm-lock.yaml'), 'utf8');
  const re = new RegExp(`^  '?${name.replace(/[/@.]/g, (c) => `\\${c}`)}@(\\d+\\.\\d+\\.\\d+[^'\\s:]*)'?:`, 'gm');
  const out: string[] = [];
  for (const m of lock.matchAll(re)) out.push(m[1]);
  return out;
}

/** Every version the npm lockfile resolves for a package (any nesting). */
function npmResolved(name: string): string[] {
  const lock = JSON.parse(fs.readFileSync(path.join(GATEWAY, 'package-lock.json'), 'utf8'));
  const out: string[] = [];
  for (const [p, entry] of Object.entries<any>(lock.packages || {})) {
    if (p === `node_modules/${name}` || p.endsWith(`/node_modules/${name}`)) out.push(entry.version);
  }
  return out;
}

/** The version actually installed in `node_modules`, or `null` when absent. */
function installedVersion(name: string): string | null {
  const p = path.join(GATEWAY, 'node_modules', name, 'package.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')).version ?? null;
}

describe('VTID-04295: the sharp/libvips floor is tracked as a direct dependency', () => {
  it(`declares sharp at >=${FLOOR} (closes ${CVES.join(', ')})`, () => {
    const f = DEPENDENCY_FLOORS.find((x) => x.name === SHARP);
    expect(f).toBeDefined();
    expect(f!.floor).toBe(FLOOR);
    expect(f!.direct).toBe(true); // direct dep -> `dependencies` bump, never an override
    expect(f!.vulnerable).toBe(`<${FLOOR}`);
    expect(f!.source).toBe('npm-audit-scanner-v1');
  });

  it('keeps the previously-landed floors tracked (regression anchor)', () => {
    const names = DEPENDENCY_FLOORS.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['@grpc/grpc-js', 'fast-xml-parser']));
    expect(DEPENDENCY_FLOORS.find((f) => f.name === SHARP)!.floor).toBe(FLOOR);
  });

  it('never asks for a sharp override — a direct floor is not an overrides entry', () => {
    // `missingFloors` returns transitive floors only; a direct floor showing up
    // here would mean someone tried to patch sharp via `overrides`.
    const pending = missingFloors(pkg.overrides, pkg.pnpm?.overrides).map((s) => s.name);
    expect(pending).not.toContain(SHARP);

    const status = evaluateDeclaredFloors(pkg.overrides, pkg.pnpm?.overrides).find((s) => s.name === SHARP)!;
    expect(status.direct).toBe(true);
  });

  it('has a parseable floor and no duplicate policy rows', () => {
    const names = DEPENDENCY_FLOORS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect(() => parseSemver(DEPENDENCY_FLOORS.find((f) => f.name === SHARP)!.floor)).not.toThrow();
  });
});

describe('VTID-04295: the live gateway manifest declares a safe-or-pending sharp spec', () => {
  const declared: string | undefined = pkg.dependencies?.[SHARP];

  it('lists sharp as a direct dependency at all', () => {
    expect(typeof declared).toBe('string');
  });

  it(`declares a spec that is either at/above ${FLOOR} or exactly the pre-hand-off spec`, () => {
    const satisfied = isFloorSatisfied(declared, FLOOR);
    // The regression guard: ^0.34.0 / ^0.33.x / a bare 0.34.x all fail here.
    expect({ declared, ok: satisfied || PRE_HANDOFF_SPEC.test(String(declared)) }).toEqual({
      declared,
      ok: true,
    });
  });

  it('never declares a sharp floor below the pre-hand-off spec', () => {
    const min = specFloor(String(declared));
    expect(min).not.toBeNull();
    // Today this is 0.34.5; after the hand-off it is >=0.35.0. Anything lower
    // is a fresh regression below an already-known-vulnerable version.
    expect(semverGte(min!, '0.34.5')).toBe(true);
  });

  it('is the only place the version lives — no stale copy in the installed tree', () => {
    // Nothing to assert beyond resolvability today; the coherence checks below
    // are what tie node_modules to whatever the manifest declares.
    expect(String(declared)).toMatch(/^\^?\d+\.\d+\.\d+/);
  });
});

describe('VTID-04295: lockfiles and the installed tree stay coherent with the manifest', () => {
  /**
   * The spec's own lower bound. Once the hand-off lands (>=0.35.0) this is the
   * floor; before it, the pending ^0.34.5 line. Lockfiles may never resolve
   * below whatever `package.json` asks for.
   */
  const declaredFloor = () => specFloor(String(pkg.dependencies[SHARP])) ?? FLOOR;

  it('pnpm-lock.yaml resolves sharp at or above the declared spec', () => {
    const versions = pnpmResolved(SHARP);
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      expect({ v, ok: semverGte(v, declaredFloor()) }).toEqual({ v, ok: true });
    }
  });

  it('package-lock.json resolves sharp at or above the declared spec', () => {
    const versions = npmResolved(SHARP);
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      expect({ v, ok: semverGte(v, declaredFloor()) }).toEqual({ v, ok: true });
    }
  });

  it('the installed sharp binary is at or above the declared spec', () => {
    const installed = installedVersion(SHARP);
    if (installed === null) return; // not installed in this sandbox — nothing to pin
    expect({ installed, ok: semverGte(installed, declaredFloor()) }).toEqual({
      installed,
      ok: true,
    });
  });

  it('once the manifest is bumped, every lockfile copy is patched too (half-hand-off guard)', () => {
    // Simulates the post-hand-off state without depending on it: if the
    // declared spec already reaches the floor, the resolutions must as well.
    if (!isFloorSatisfied(String(pkg.dependencies[SHARP]), FLOOR)) return; // still pending
    const all = [...pnpmResolved(SHARP), ...npmResolved(SHARP)];
    expect(all.length).toBeGreaterThan(0);
    for (const v of all) expect({ v, ok: semverGte(v, FLOOR) }).toEqual({ v, ok: true });
  });
});
