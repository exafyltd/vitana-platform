/**
 * VTID-04133 — machine-to-machine auth for the Operator Console.
 *
 * Background: `autopilot_run_task`/`autopilot_execute_task` require a
 * verified exafy_admin session (VTID-03851, `operator-execute-authz.ts`) —
 * correctly, since an anonymous caller must never queue a real code
 * execution. But that gate only recognizes a human Supabase JWT
 * (`Authorization: Bearer <jwt>`), so the only way to test the on-ramp
 * end-to-end was for a person to sign in through the browser and copy a
 * token out, or for an automated caller to hold a real user's password —
 * neither of which a CI harness or an automated test session should ever
 * do (this codebase treats holding/using a human password as a
 * secret-handling action, not something to automate around).
 *
 * This module adds a SECOND, narrower, opt-in credential: a static shared
 * secret presented in its OWN header (`X-Operator-Machine-Token`, never
 * `Authorization`, so it can never be confused with — or silently
 * override — a real bearer JWT). It resolves to a clearly-synthetic
 * identity (`OPERATOR_MACHINE_IDENTITY.user_id`), never a real user id, so
 * it can never collide with an actual account and is trivially
 * greppable/excludable from anything user-facing if it were ever to leak
 * into a query it has no business being in (it never is one — this is
 * API-only, never inserted into `user_tenants`/`profiles`).
 *
 * Same activation-gate convention as every other opt-in provider in this
 * codebase (Bedrock's BEDROCK_ROLE_ARN, Fish's FISH_API_KEY, the SQL
 * read-only seam's OPERATOR_SQL_READONLY_DATABASE_URL): unset by default,
 * two independent conditions both required, and comparison is
 * constant-time so a slow string compare can't leak the secret via timing.
 */

import { timingSafeEqual } from 'crypto';

export const OPERATOR_MACHINE_AUTH_HEADER = 'x-operator-machine-token';

/** A clearly-synthetic identity — never a real user id, never a real email. */
export const OPERATOR_MACHINE_IDENTITY = Object.freeze({
  user_id: 'operator-machine-test-harness',
  email: null as string | null,
  tenant_id: null as string | null,
  exafy_admin: true,
  role: 'machine' as string | null,
  aud: null as string | null,
  exp: null as number | null,
  iat: null as number | null,
});

/** Kill switch — exact string 'true', same convention as OPERATOR_SQL_READONLY_ENABLED. */
export function isOperatorMachineAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPERATOR_MACHINE_AUTH_ENABLED === 'true';
}

function configuredToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env.OPERATOR_MACHINE_AUTH_TOKEN || '').trim();
  return v.length >= 32 ? v : null; // refuse a too-short/placeholder secret outright
}

/**
 * Constant-time comparison against the configured secret. Returns false
 * (never throws) on length mismatch, missing config, or an empty token —
 * every failure path is a plain "no", so the caller can't distinguish
 * "not configured" from "wrong token" by timing or by exception shape.
 */
export function verifyOperatorMachineAuthToken(
  candidate: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const expected = configuredToken(env);
  if (!expected || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Resolve the machine identity for a request, or null if this request
 * doesn't carry (or doesn't correctly present) the machine credential.
 * Callers must only use this when no real identity (optionalAuth) already
 * resolved one — a real human session always wins, this never overrides it.
 */
export function resolveOperatorMachineIdentity(
  headerValue: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env
): typeof OPERATOR_MACHINE_IDENTITY | null {
  if (!isOperatorMachineAuthEnabled(env)) return null;
  const token = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!verifyOperatorMachineAuthToken(token, env)) return null;
  return OPERATOR_MACHINE_IDENTITY;
}
