/**
 * VTID-02978 (M1): worker-runner canary target.
 *
 * Mirrors the gateway canary (PR-I) for the M1 worker-runner green-path
 * proof. Operator flips `system_config.worker_runner_canary_armed=true`
 * to deliberately fail `/api/v1/canary-target/health`. The test contract
 * for this endpoint then fails, the gateway failure scanner allocates a
 * repair VTID, the dev_autopilot pipeline writes the fix (catch the
 * typed fault, return degraded shape), CI/deploy lands, and the next
 * scheduled scan flips the contract back to pass.
 *
 * Repeatability caveat (same as the gateway canary): after the LLM's
 * narrow-catch lands, re-arming returns 200 with the degraded shape
 * directly. Acceptable for proving the green path once.
 */

import { Router, Request, Response } from 'express';

const canaryTargetRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const CONFIG_KEY = 'worker_runner_canary_armed';

let cachedArmed: boolean | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5_000;

/**
 * Typed fault thrown when the canary is armed. The repair contract is:
 * catch ONLY this error class (not generic Error) and return a degraded
 * JSON response. Catching `Error` broadly would mask real bugs and is
 * the wrong autonomy habit.
 */
export class WorkerRunnerCanaryArmedFault extends Error {
  readonly code = 'WORKER_RUNNER_CANARY_ARMED';
  constructor() {
    super('worker-runner canary is armed via system_config[worker_runner_canary_armed]=true');
    this.name = 'WorkerRunnerCanaryArmedFault';
  }
}

export async function isWorkerRunnerCanaryArmed(): Promise<boolean> {
  const now = Date.now();
  if (cachedArmed !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedArmed;
  }
  cachedArmed = false;
  cachedAt = now;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return false;
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/system_config?key=eq.${CONFIG_KEY}&select=value`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!resp.ok) return false;
    const rows = (await resp.json()) as Array<{ value: unknown }>;
    if (rows.length === 0) return false;
    const v = rows[0].value;
    cachedArmed = v === true || v === 'true' || v === 1 || v === '1';
    return cachedArmed;
  } catch {
    return false;
  }
}

/**
 * GET /api/v1/canary-target/health
 *
 * Disarmed → 200 with { ok: true, armed: false }.
 * Armed    → throws WorkerRunnerCanaryArmedFault, surfaced as 500 by
 *            Express's default error handler. The failure scanner sees
 *            the 500 and allocates a repair VTID.
 *
 * The repair contract — same shape as the gateway canary:
 *   - catch WorkerRunnerCanaryArmedFault specifically (NOT generic Error)
 *   - return 200 with { ok:true, degraded:true, fault_class:
 *     'WORKER_RUNNER_CANARY_ARMED', remediation:'...' }
 */
canaryTargetRouter.get('/health', async (_req: Request, res: Response, next: (err?: any) => void) => {
  try {
    const armed = await isWorkerRunnerCanaryArmed();
    if (armed) {
      throw new WorkerRunnerCanaryArmedFault();
    }
    return res.status(200).json({ ok: true, armed: false });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/v1/canary-target/status — operator-facing read-only.
 */
canaryTargetRouter.get('/status', async (_req: Request, res: Response) => {
  const armed = await isWorkerRunnerCanaryArmed();
  return res.json({ ok: true, armed, config_key: CONFIG_KEY });
});

export default canaryTargetRouter;
