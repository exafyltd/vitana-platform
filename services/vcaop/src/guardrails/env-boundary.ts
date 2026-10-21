/**
 * Hard dev/staging environment boundary (runbook Sec. 0.2, Sec. 3).
 *
 * Refuses (throws) on any prod target, destructive DB op, IAM call, or
 * billing-impacting call. Wraps deploy/migration helpers so a feature cannot
 * route around it. Fail-closed: an unset/unknown environment is treated as prod.
 */
import { EnvBoundaryViolation } from './errors';

export type VcaopEnv = 'dev' | 'staging' | 'test';

const DEV_LIKE = new Set(['dev', 'development', 'staging', 'test']);

/** Classify the current environment from VCAOP_ENV (preferred) then NODE_ENV. */
export function currentEnv(env: NodeJS.ProcessEnv = process.env): VcaopEnv | 'prod' {
  const raw = (env.VCAOP_ENV ?? env.NODE_ENV ?? '').trim().toLowerCase();
  if (!DEV_LIKE.has(raw)) return 'prod'; // fail-closed: unknown/unset => prod
  if (raw === 'development') return 'dev';
  return raw as VcaopEnv;
}

export function isDevLike(env: NodeJS.ProcessEnv = process.env): boolean {
  return currentEnv(env) !== 'prod';
}

/** Throw unless we are running in a dev-like environment. */
export function assertDevEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  if (!isDevLike(env)) {
    throw new EnvBoundaryViolation(
      `Refusing operation: environment is not dev/staging (resolved "prod" from VCAOP_ENV/NODE_ENV). ` +
        `Set VCAOP_ENV to one of dev|staging|test.`,
    );
  }
}

/** Tokens that mark a deploy/DB/secret target as production. Case-insensitive. */
const PROD_TARGET_PATTERNS = [
  /\bprod\b/i,
  /\bproduction\b/i,
  /-prod(\b|[-_./])/i,
  /(\b|[-_./])prod-/i,
  /\blive\b/i,
];

/**
 * Assert a deploy/DB target string is NOT production.
 * Used to vet Cloud Run service names, Supabase URLs, revision tags, etc.
 */
export function assertNonProdTarget(target: string): void {
  const t = (target ?? '').trim();
  if (t === '') {
    throw new EnvBoundaryViolation('Empty deploy/DB target — refusing (fail-closed)');
  }
  for (const re of PROD_TARGET_PATTERNS) {
    if (re.test(t)) {
      throw new EnvBoundaryViolation(`Target "${t}" looks like production — refused`);
    }
  }
}

/** Destructive SQL verbs forbidden without approval (Sec. 0.2). */
const DESTRUCTIVE_SQL = [
  /\bDROP\s+(TABLE|DATABASE|SCHEMA|COLUMN)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)/i, // unbounded DELETE (no WHERE)
  /\bALTER\s+TABLE\b[^;]*\bDROP\b/i,
];

/** Throw if a SQL string is a destructive op (DROP/TRUNCATE/destructive ALTER/bulk DELETE). */
export function assertNotDestructiveSql(sql: string): void {
  const s = sql ?? '';
  for (const re of DESTRUCTIVE_SQL) {
    if (re.test(s)) {
      throw new EnvBoundaryViolation(
        `Destructive DB operation refused (Sec. 0.2 — needs approval + tested rollback): ${s.slice(0, 120)}`,
      );
    }
  }
}

/** IAM/billing/DNS surfaces the build must never touch (Sec. 0.2). Always refuse. */
export function assertNoIamChange(description: string): never {
  throw new EnvBoundaryViolation(`IAM change refused (Tier-B / forbidden): ${description}`);
}

export function assertNoBillingChange(description: string): never {
  throw new EnvBoundaryViolation(`Billing-impacting infra refused (Tier-B / forbidden): ${description}`);
}

export interface DeploySpec {
  /** Cloud Run service name; must be *-dev or a no-traffic tagged revision. */
  service: string;
  /** True for tagged no-traffic Gateway revisions (allowed). */
  noTraffic?: boolean;
  region?: string;
}

/**
 * Guard a dev deploy. Allowed only when:
 *  - environment is dev-like, AND
 *  - the service name is non-prod, AND
 *  - either the service name ends with `-dev` OR it is a no-traffic tagged revision.
 * Returns the validated spec; throws EnvBoundaryViolation otherwise. The caller
 * performs the actual `gcloud run deploy` (this guard does not shell out).
 */
export function guardedDeploy(spec: DeploySpec, env: NodeJS.ProcessEnv = process.env): DeploySpec {
  assertDevEnvironment(env);
  assertNonProdTarget(spec.service);
  const isDevService = /-dev$/.test(spec.service);
  if (!isDevService && !spec.noTraffic) {
    throw new EnvBoundaryViolation(
      `Deploy target "${spec.service}" must be a *-dev service or a no-traffic tagged revision (Sec. 0.2/0.6)`,
    );
  }
  return spec;
}

export interface MigrationSpec {
  /** The DB target (e.g., Supabase URL / project ref). Must be non-prod. */
  target: string;
  /** Up SQL/statement (for destructiveness check). */
  up: string;
  /** A recorded, reversible down path is mandatory (Sec. 0.7). */
  down: string | null;
}

/**
 * Guard a dev migration. Requires: dev env, non-prod target, non-destructive up,
 * and a recorded down path (Sec. 0.7 — no migration without a tested rollback).
 */
export function guardedMigration(spec: MigrationSpec, env: NodeJS.ProcessEnv = process.env): MigrationSpec {
  assertDevEnvironment(env);
  assertNonProdTarget(spec.target);
  assertNotDestructiveSql(spec.up);
  if (!spec.down || spec.down.trim() === '') {
    throw new EnvBoundaryViolation(
      `Migration on "${spec.target}" has no recorded down/rollback path (Sec. 0.7) — refused`,
    );
  }
  return spec;
}
