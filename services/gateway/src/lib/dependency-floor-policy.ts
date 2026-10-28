/**
 * VTID-04261 — machine-readable dependency-floor policy for the gateway.
 *
 * `npm-audit-scanner-v1` (scripts/ci/scanners/npm-audit.mjs) audits
 * `services/gateway/package-lock.json` and emits a `cve` finding per
 * high/critical advisory. VTID-04261 is the `fast-xml-builder` /
 * `fast-xml-parser` pass: both arrive transitively (AWS SDK v3 `@aws-sdk/*`
 * and `firebase-admin` pull them in), so the canonical fix is an `overrides`
 * floor, not a direct-dependency bump.
 *
 * WHY THIS MODULE EXISTS, NOT JUST THE MANIFEST EDIT
 * --------------------------------------------------
 * The actual `services/gateway/package.json` + lockfile edit is outside the
 * Dev Autopilot executor's `allow_scope` (same wall VTID-04237 and VTID-04163
 * hit for the previous floors). The durable pattern that came out of those
 * runs — and that `test/vtid-04245-dependency-floors.test.ts` still follows —
 * is: the floors are declared here as data, a pure evaluator reports whether
 * the live manifest actually enforces them, and the jest suite pins both. The
 * manifest bump stays a manual, reviewable hand-off; this module means the
 * hand-off cannot be forgotten or silently regressed, and the pending state is
 * a machine-readable fact rather than a PR comment.
 *
 * The gateway image installs with `npm` (see the Dockerfile) while CI/dev use
 * `pnpm`, so a floor is only actually applied when BOTH `overrides` (npm) and
 * `pnpm.overrides` carry it — `evaluateDeclaredFloors` models that directly.
 */

export interface DependencyFloor {
  /** npm package name. */
  name: string;
  /** Minimum safe version (inclusive). An override spec must resolve at/above it. */
  floor: string;
  /**
   * `true` when the package is a direct dependency (bumped in `dependencies`);
   * `false` when it is transitive and therefore needs an `overrides` entry.
   */
  direct: boolean;
  /** The vulnerable range this floor closes, for traceability. */
  vulnerable: string;
  /** Which scanner produced the finding. */
  source: 'npm-audit-scanner-v1';
}

/**
 * Every gateway dependency floor the npm-audit scanner has produced. Ordered
 * newest-first so the current pass (VTID-04261) reads first.
 */
export const DEPENDENCY_FLOORS: readonly DependencyFloor[] = [
  {
    name: 'fast-xml-builder',
    floor: '1.2.0',
    direct: false,
    vulnerable: '<=1.1.6',
    source: 'npm-audit-scanner-v1',
  },
  {
    name: 'fast-xml-parser',
    floor: '5.5.7',
    direct: false,
    vulnerable: '>=5.0.0 <5.5.7',
    source: 'npm-audit-scanner-v1',
  },
  {
    name: 'express-rate-limit',
    floor: '8.2.2',
    direct: true,
    vulnerable: '<8.2.2',
    source: 'npm-audit-scanner-v1',
  },
  {
    name: '@modelcontextprotocol/sdk',
    floor: '1.24.0',
    direct: true,
    vulnerable: '<1.24.0',
    source: 'npm-audit-scanner-v1',
  },
  {
    name: '@grpc/grpc-js',
    floor: '1.14.4',
    direct: false,
    vulnerable: '<1.14.4',
    source: 'npm-audit-scanner-v1',
  },
];

/** Parse the leading `major.minor.patch` out of a version or range spec. */
export function parseSemver(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) throw new Error(`not a semver: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** `a >= b` for `major.minor.patch` versions. */
export function semverGte(a: string, b: string): boolean {
  const [a1, a2, a3] = parseSemver(a);
  const [b1, b2, b3] = parseSemver(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 >= b3;
}

/**
 * The minimum version an override/range spec enforces, or `null` when the spec
 * has no lower bound we can reason about (e.g. a bare upper bound like
 * `"<9.0.0"`, which never guarantees a floor).
 */
export function specFloor(spec: string): string | null {
  const trimmed = spec.trim();
  // An upper bound alone asserts no minimum — refuse rather than guess.
  if (trimmed.startsWith('<')) return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(trimmed);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Does `spec` (an `overrides` entry value) enforce at least `floor`? */
export function isFloorSatisfied(spec: string | undefined | null, floor: string): boolean {
  if (!spec) return false;
  const min = specFloor(spec);
  return min !== null && semverGte(min, floor);
}

export interface FloorStatus {
  name: string;
  floor: string;
  direct: boolean;
  /** Declared npm `overrides` value, or `null`. */
  npm: string | null;
  /** Declared `pnpm.overrides` value, or `null`. */
  pnpm: string | null;
  /**
   * `true` only when BOTH managers declare the floor at/above the minimum —
   * patching one install path patches only one of them.
   */
  satisfied: boolean;
}

/**
 * Evaluate the policy against a live manifest's override blocks. Pure — takes
 * the already-parsed objects so it is trivial to unit test (no `fs`).
 */
export function evaluateDeclaredFloors(
  overrides: Record<string, string> | undefined | null,
  pnpmOverrides: Record<string, string> | undefined | null,
): FloorStatus[] {
  return DEPENDENCY_FLOORS.map((f) => {
    const npm = overrides?.[f.name] ?? null;
    const pnpm = pnpmOverrides?.[f.name] ?? null;
    return {
      name: f.name,
      floor: f.floor,
      direct: f.direct,
      npm,
      pnpm,
      satisfied: isFloorSatisfied(npm, f.floor) && isFloorSatisfied(pnpm, f.floor),
    };
  });
}

/**
 * The transitive floors (`direct === false`) that are NOT yet enforced by both
 * managers — i.e. the exact set a human has to add to `package.json`. Empty
 * once the hand-off lands.
 */
export function missingFloors(
  overrides: Record<string, string> | undefined | null,
  pnpmOverrides: Record<string, string> | undefined | null,
): FloorStatus[] {
  return evaluateDeclaredFloors(overrides, pnpmOverrides).filter((s) => !s.direct && !s.satisfied);
}
