/**
 * VTID-DA-59875200: dependency-safety guard for the gateway manifest.
 *
 * The npm-audit-scanner-v1 run flagged three packages against
 * `services/gateway/package.json` (@grpc/grpc-js transitive → needs an
 * `overrides` pin; @modelcontextprotocol/sdk and express-rate-limit direct
 * bumps). A one-off bump has no memory: the next `pnpm update` can walk any
 * of the three straight back below its advisory range and nothing fails.
 *
 * So the floors live in `config/gateway-dependency-safety.json` and this
 * module is the pure checker that validates a parsed manifest against them.
 * No fs, no network — the caller passes both objects in, which is what makes
 * the range maths testable without installing anything.
 *
 * Fail-loud bias (CLAUDE.md Part 1 "Never silence errors"): a spec this
 * module cannot turn into a lower bound is a violation, not a pass. Only two
 * spec shapes are treated as "anything": '*', 'x' and 'latest' — and those
 * resolve to 0.0.0, which is below every floor in the policy.
 */

export type DependencyField = 'dependencies' | 'devDependencies' | 'overrides';

export interface DependencyRequirement {
  /** npm package name, e.g. '@grpc/grpc-js'. */
  package: string;
  /** Which manifest section the floor applies to. */
  field: DependencyField;
  /** Lowest acceptable version (dotted, numeric). */
  min_version: string;
  /** Finding severity, carried through for reporting. */
  severity?: string;
  /** Why the floor exists (advisory / dependency path). */
  reason?: string;
}

export interface PendingRemediation {
  finding_id?: string;
  task?: string;
  reason?: string;
  packages?: string[];
}

export interface DependencySafetyPolicy {
  service?: string;
  manifest?: string;
  requirements: DependencyRequirement[];
  /**
   * Present only while the manifest has NOT yet received the bump — it
   * records the hand-off explicitly so the gap can't rot silently. The test
   * treats its presence as "violations must be exactly these packages", and
   * its removal as "the manifest must now satisfy every floor".
   */
  pending_remediation?: PendingRemediation;
}

export type DependencyViolationCode =
  | 'package_missing'
  | 'below_minimum'
  | 'unparseable_range';

export interface DependencyViolation {
  package: string;
  field: DependencyField;
  /** The policy floor that was not met. */
  expected_min: string;
  /** The spec actually found in the manifest, null when absent. */
  actual: string | null;
  code: DependencyViolationCode;
  message: string;
}

export interface DependencySafetyResult {
  ok: boolean;
  violations: DependencyViolation[];
  /** Packages that were found AND had a parsable range at/above the floor. */
  checked: string[];
}

type Manifest = Record<string, unknown>;

const WILDCARD_SPECS = new Set(['*', 'x', 'X', 'latest']);

/**
 * Turn a version token into 'major.minor.patch', or null when it isn't a
 * version at all. Missing components become 0, 'x'/'*' components become 0
 * (a wildcard component is not a floor), and any prerelease/build suffix is
 * dropped (1.14.4-rc.1 is the 1.14.4 line for floor purposes).
 */
function normalizeVersionToken(token: string): string | null {
  const cleaned = token.trim().replace(/^[vV=\s]+/, '');
  if (!cleaned) return null;
  const m = cleaned.match(/^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/);
  if (!m) return null;
  const parts = [m[1], m[2] ?? '0', m[3] ?? '0'].map((p) => (/^\d+$/.test(p) ? p : '0'));
  return parts.join('.');
}

/** Numeric triple comparison of two normalized versions. */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersionToken(a);
  const pb = normalizeVersionToken(b);
  if (pa === null || pb === null) {
    throw new Error(`compareVersions: unparseable version (${a} vs ${b})`);
  }
  const va = pa.split('.').map(Number);
  const vb = pb.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] < vb[i] ? -1 : 1;
  }
  return 0;
}

function lowerBoundOfSingleRange(spec: string): string | null {
  const s = spec.trim();
  if (!s) return null;
  if (WILDCARD_SPECS.has(s)) return '0.0.0';

  // Hyphen range: "1.2.3 - 2.0.0" → floor is the left side.
  const hyphen = s.match(/^(\S+)\s+-\s+(\S+)$/);
  if (hyphen) return normalizeVersionToken(hyphen[1]);

  // Space-joined comparator list: ">=1.2.3 <2.0.0" → first bound that is
  // a floor. '<' tokens are upper bounds and yield nothing (`<2.0.0` alone
  // is therefore a violation — no floor means no proof of safety).
  const tokens = s.split(/\s+/);
  if (tokens.length > 1) {
    for (const t of tokens) {
      const bound = lowerBoundOfSingleRange(t);
      if (bound !== null) return bound;
    }
    return null;
  }

  if (s.startsWith('>=')) return normalizeVersionToken(s.slice(2));
  if (s.startsWith('>')) return normalizeVersionToken(s.slice(1));
  if (s.startsWith('^')) return normalizeVersionToken(s.slice(1));
  if (s.startsWith('~')) return normalizeVersionToken(s.slice(1));
  if (s.startsWith('<')) return null;
  return normalizeVersionToken(s);
}

/**
 * Lowest version a range accepts, or null when the spec has no determinable
 * floor. Caret/tilde floors are exact; for a `>` comparator the excluded
 * boundary itself is reported (documented under-approximation — it can only
 * ever mark a spec as too low, never too high).
 */
export function extractLowerBound(range: string): string | null {
  const branches = range.split('||');
  let lowest: string | null = null;
  for (const branch of branches) {
    const bound = lowerBoundOfSingleRange(branch);
    if (bound === null) continue;
    if (lowest === null || compareVersions(bound, lowest) < 0) lowest = bound;
  }
  return lowest;
}

/**
 * Validate every requirement in the policy against the parsed manifest.
 * A package that is absent (including "no `overrides` section at all") is a
 * violation — that is exactly the @grpc/grpc-js case, where the vulnerable
 * copy is transitive and only an override can raise it.
 */
export function checkDependencySafety(
  manifest: Manifest,
  policy: DependencySafetyPolicy,
): DependencySafetyResult {
  const violations: DependencyViolation[] = [];
  const checked: string[] = [];

  for (const req of policy.requirements ?? []) {
    const section = manifest[req.field];
    const actual = section && typeof section === 'object'
      ? (section as Record<string, unknown>)[req.package]
      : undefined;

    if (typeof actual !== 'string') {
      violations.push({
        package: req.package,
        field: req.field,
        expected_min: req.min_version,
        actual: null,
        code: 'package_missing',
        message: `${req.package} is not declared in "${req.field}" — expected >= ${req.min_version}`,
      });
      continue;
    }

    const floor = extractLowerBound(actual);
    const minNorm = normalizeVersionToken(req.min_version);
    if (floor === null || minNorm === null) {
      violations.push({
        package: req.package,
        field: req.field,
        expected_min: req.min_version,
        actual,
        code: 'unparseable_range',
        message: `${req.package} range "${actual}" has no determinable lower bound — cannot prove it is >= ${req.min_version}`,
      });
      continue;
    }

    if (compareVersions(floor, minNorm) < 0) {
      violations.push({
        package: req.package,
        field: req.field,
        expected_min: req.min_version,
        actual,
        code: 'below_minimum',
        message: `${req.package} "${actual}" allows ${floor}, below the safe floor ${req.min_version}`,
      });
      continue;
    }

    checked.push(req.package);
  }

  return { ok: violations.length === 0, violations, checked };
}
