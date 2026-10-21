/**
 * Self-Healing Canary Target — PR-I (VTID-02949)
 *
 * Replaces the old `services/gateway/src/routes/self-healing-canary.ts`.
 * The old canary mounted at `/` so the diagnosis layer couldn't infer a
 * conventional route file from the endpoint path — it always blamed
 * `services/gateway/src/index.ts`, which the autopilot safety gate
 * (correctly) refused to edit. PR-I gives the canary a normal mount
 * (`/api/v1/canary-target`) so diagnosis lands on THIS file, and a
 * typed-fault pattern so the LLM has an unambiguous, narrow repair
 * target rather than the temptation to swallow all errors.
 *
 * Lifecycle:
 *   1. Operator flips `system_config.self_healing_canary_armed = true`.
 *   2. Scanner detects /health 500'ing → /report → diagnose →
 *      diagnosis names this file (since the endpoint maps cleanly to
 *      services/gateway/src/routes/canary-target.ts via ENDPOINT_FILE_MAP).
 *   3. Self-healing injector derives the paired test path
 *      (services/gateway/test/canary-target.test.ts — pre-existing
 *      stub means PR-H sees `existing: true` → modify verb).
 *   4. Autopilot bridge succeeds (safety gate accepts: route file +
 *      test file, scope OK).
 *   5. LLM produces the narrow repair: catch ONLY CanaryArmedFault,
 *      return a degraded-but-healthy response. Test asserts the
 *      degraded shape.
 *   6. PR opens, CI passes, deploy lands, /health probe passes,
 *      reconciler marks terminal_outcome='success'.
 *
 * Repeatability caveat: after the LLM's fix is merged, re-arming the
 * canary will NOT reproduce the failure — the typed-fault catch will
 * absorb it. Future runs need either a new fault mode or a manual
 * revert. This is acceptable for proving the green path once.
 */

import { Router, Request, Response } from 'express';

const canaryTargetRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const CONFIG_KEY = 'self_healing_canary_armed';

let cachedArmed: boolean | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5_000;

/**
 * Typed fault thrown when the canary is armed. The autonomous-repair
 * contract is: catch ONLY this error class (not generic Error), return
 * a degraded JSON response. Catching `Error` broadly would mask real
 * bugs and is the wrong autonomy habit.
 */
export class CanaryArmedFault extends Error {
  readonly code = 'CANARY_ARMED';
  constructor() {
    super('canary is armed via system_config[self_healing_canary_armed]=true');
    this.name = 'CanaryArmedFault';
  }
}

export async function isCanaryArmed(): Promise<boolean> {
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
 * GET /health (mounted at /api/v1/canary-target/health)
 *
 * Disarmed → 200 OK (steady state).
 *
 * Armed → throws CanaryArmedFault, which Express's default error handler
 * surfaces as a 500. The self-healing pipeline detects the 500 and
 * proposes a repair.
 *
 * The repair contract is enforced by the paired test:
 *   - Catch CanaryArmedFault specifically (NOT generic Error).
 *   - Return 200 with `{ ok: true, degraded: true, fault_class: 'CANARY_ARMED', remediation: '...' }`
 *     so observability still flags the underlying flag-on state.
 *   - The operator-facing `armed` flag stays the source of truth; the
 *     handler just stops 500'ing on it.
 */
canaryTargetRouter.get('/health', async (_req: Request, res: Response, next: (err?: any) => void) => {
  try {
    const armed = await isCanaryArmed();
    if (armed) {
      throw new CanaryArmedFault();
    }
    return res.status(200).json({ ok: true, armed: false });
  } catch (err) {
    if (err instanceof CanaryArmedFault) {
      return res.status(200).json({
        ok: true,
        degraded: true,
        fault_class: 'CANARY_ARMED',
        remediation: 'Canary armed fault handled gracefully.'
      });
    }
    return next(err);
  }
});

/**
 * GET /status — operator-facing read-only.
 */
canaryTargetRouter.get('/status', async (_req: Request, res: Response) => {
  const armed = await isCanaryArmed();
  return res.json({ ok: true, armed, config_key: CONFIG_KEY });
});

export default canaryTargetRouter;