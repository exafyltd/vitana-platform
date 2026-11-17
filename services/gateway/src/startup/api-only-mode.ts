/**
 * GATEWAY_API_ONLY — API-only startup mode for the isolated preview gateway.
 *
 * When `GATEWAY_API_ONLY` is exactly the string `'true'`, the gateway keeps
 * its HTTP listener and every API route (plan-sparring included), and
 * `src/index.ts` skips the ENTIRE background startup section that runs inside
 * the `app.listen` callback: schedulers, loops, workers, timers, WebSocket
 * voice, graceful-shutdown drains and cache warmers. Nothing is started that
 * can send mail or push, call an outside service, sync a connected app,
 * reconcile data, allocate VTIDs or execute autonomous work.
 *
 * Fail-safe direction: only the exact value enables the mode. Unset, empty,
 * `TRUE`, `1` or any typo keeps the full production startup, so this flag
 * can never switch background work off by accident in production.
 *
 * The guard is a control flow decision in index.ts, not a set of per-worker
 * feature flags, so a worker that is added later and placed after the guard
 * is skipped without anyone remembering to flag it.
 */
export const GATEWAY_API_ONLY_ENV = 'GATEWAY_API_ONLY';

export function isGatewayApiOnlyMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[GATEWAY_API_ONLY_ENV] === 'true';
}
