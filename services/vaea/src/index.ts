/**
 * VTID-02400: Vitana Autonomous Economic Actor (VAEA) — Phase 0 scaffold.
 *
 * Machine-to-machine referral agent. Phase 0 ships:
 *   - service skeleton (Express + /alive + /metrics)
 *   - vaea_config + vaea_referral_catalog tables (via migration)
 *   - three-switch model (receive / give / make-money goal)
 *   - feature flags (VAEA_ENABLED, VAEA_AUTO_EXECUTE_ENABLED)
 *
 * NO loops yet. Listeners, classifier, mesh broker, playbooks arrive in Phase 1+.
 */

import express, { Request, Response } from 'express';
import { config as dotenvConfig } from 'dotenv';
import { readFeatureFlags } from './lib/feature-flags';
import { startAgentRegistration } from './lib/agents-registry-client';

dotenvConfig();

const VTID = 'VTID-02400';
const PORT = parseInt(process.env.PORT || '8080', 10);

const app = express();
app.use(express.json());

const startedAt = new Date().toISOString();
let stopAgentRegistration: (() => void) | null = null;

app.get('/alive', (_req: Request, res: Response) => {
  const flags = readFeatureFlags();
  res.json({
    status: 'healthy',
    vtid: VTID,
    service: 'vaea',
    phase: 0,
    started_at: startedAt,
    feature_flags: flags,
  });
});

app.get('/ready', (_req: Request, res: Response) => {
  res.json({ ready: true });
});

app.get('/live', (_req: Request, res: Response) => {
  res.json({ live: true });
});

app.get('/metrics', (_req: Request, res: Response) => {
  res.json({
    vtid: VTID,
    service: 'vaea',
    phase: 0,
    loops_enabled: false,
    feature_flags: readFeatureFlags(),
    environment: {
      supabase_url_set: Boolean(process.env.SUPABASE_URL),
      gateway_url: process.env.GATEWAY_URL || 'not set',
    },
  });
});

async function main(): Promise<void> {
  console.log(`[${VTID}] VAEA Phase 0 scaffold starting...`);
  const flags = readFeatureFlags();
  console.log(`[${VTID}] Feature flags:`, flags);

  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE'];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`[${VTID}] Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`[${VTID}] Health server listening on port ${PORT}`);
  });

  try {
    stopAgentRegistration = startAgentRegistration({
      gatewayUrl: process.env.GATEWAY_URL || '',
      agentId: 'vaea',
      displayName: 'Vitana Autonomous Economic Actor',
      description: 'M2M referral agent — Phase 0 scaffold, no loops yet',
      tier: 'service',
      role: 'economic-actor',
      sourcePath: 'services/vaea/',
      healthEndpoint: '/alive',
      metadata: { vtid: VTID, phase: 0 },
    });
  } catch (err) {
    console.warn(`[${VTID}] agents-registry self-registration failed (non-fatal):`, err);
  }

  const shutdown = (signal: string): void => {
    console.log(`[${VTID}] Received ${signal}, shutting down...`);
    if (stopAgentRegistration) {
      try { stopAgentRegistration(); } catch { /* best-effort */ }
    }
    server.close(() => {
      console.log(`[${VTID}] Server closed`);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 30000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(`[${VTID}] Fatal startup error:`, err);
  process.exit(1);
});
