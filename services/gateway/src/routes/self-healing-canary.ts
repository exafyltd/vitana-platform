/**
 * Self-Healing Canary Route — PR-A (VTID-02922)
 *
 * A deliberate, operator-armed fault inside the same production gateway so
 * the end-to-end self-healing pipeline can be smoke-tested without inducing
 * a real production outage (e.g. pushing a syntax error). The endpoint:
 *
 *   - returns HTTP 500 with content-type application/json (so the
 *     scanner picks it up + the pre-probe gate's JSON-healthy check
 *     correctly classifies it as down) IFF
 *     system_config['self_healing_canary_armed'] === true.
 *   - returns 200 OK otherwise.
 *
 * To smoke-test the full pipeline:
 *   1. PATCH system_config { self_healing_canary_armed: true }
 *   2. POST /api/v1/self-healing/report with the canary endpoint listed as
 *      down (or wait for the scheduled scanner to detect).
 *   3. Watch self_healing_log → vtid_ledger → dev_autopilot_executions
 *      transition through pr_open → ci → merging → deploying → verifying →
 *      completed. The autopilot-generated fix typically flips
 *      self_healing_canary_armed back to false.
 *   4. Reconciler terminalizes the VTID success when the live probe
 *      returns 200.
 */

import { Router, Request, Response } from 'express';

export const selfHealingCanaryRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const CONFIG_KEY = 'self_healing_canary_armed';

let cachedArmed: boolean | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5_000;

async function isCanaryArmed(): Promise<boolean> {
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
 * GET /api/v1/self-healing/canary/failing-health
 *
 * - 200 OK (canary disarmed — baseline state)
 * - 500 with JSON body (canary armed — feeds the self-healing pipeline)
 */
selfHealingCanaryRouter.get('/api/v1/self-healing/canary/failing-health', async (_req: Request, res: Response) => {
  const armed = await isCanaryArmed();
  if (armed) {
    return res.status(500).json({
      ok: false,
      error: 'self_healing_canary_armed=true — deliberate fault for smoke-testing the self-healing pipeline',
      armed: true,
      remediation: 'flip system_config self_healing_canary_armed to false',
    });
  }
  return res.status(200).json({
    ok: true,
    armed: false,
    description: 'canary disarmed; flip system_config[self_healing_canary_armed]=true to arm',
  });
});

/**
 * GET /api/v1/self-healing/canary/status
 *
 * Operator-facing read-only check. Always 200; reports current armed state.
 */
selfHealingCanaryRouter.get('/api/v1/self-healing/canary/status', async (_req: Request, res: Response) => {
  const armed = await isCanaryArmed();
  return res.json({ ok: true, armed, config_key: CONFIG_KEY });
});

export default selfHealingCanaryRouter;
