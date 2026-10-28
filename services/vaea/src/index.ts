/**
 * VTID-02400 / VTID-02401: Vitana Autonomous Economic Actor (VAEA).
 *
 * Phase 0 shipped: service skeleton, config + catalog tables, three switches.
 * Phase 1 (this): observe-mode loop — ingest messages from listener channels,
 * classify buying intent, match against user's catalog, write shadow drafts.
 *
 * Still no external posting. Still no mesh. Loop gated behind
 * VAEA_PHASE_1_OBSERVE_ENABLED, which is itself gated behind VAEA_ENABLED.
 */

import express, { Request, Response } from 'express';
import { config as dotenvConfig } from 'dotenv';
import { readFeatureFlags } from './lib/feature-flags';
import { startAgentRegistration } from './lib/agents-registry-client';
import { getSupabase } from './lib/supabase';
import { runObservePass, getObserveMetrics } from './loops/observe';

dotenvConfig();

const VTID = 'VTID-02401';
const PORT = parseInt(process.env.PORT || '8080', 10);

const app = express();
app.use(express.json());

const startedAt = new Date().toISOString();
let stopAgentRegistration: (() => void) | null = null;
let observeTimer: NodeJS.Timeout | null = null;

app.get('/alive', (_req: Request, res: Response) => {
  const flags = readFeatureFlags();
  res.json({
    status: 'healthy',
    vtid: VTID,
    service: 'vaea',
    phase: 1,
    started_at: startedAt,
    feature_flags: flags,
    observe_metrics: getObserveMetrics(),
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
    phase: 1,
    feature_flags: readFeatureFlags(),
    observe_metrics: getObserveMetrics(),
    environment: {
      supabase_url_set: Boolean(process.env.SUPABASE_URL),
      gateway_url: process.env.GATEWAY_URL || 'not set',
    },
  });
});

app.post('/admin/observe/run-once', async (_req: Request, res: Response) => {
  const flags = readFeatureFlags();
  if (!flags.vaeaEnabled) {
    res.status(423).json({ ok: false, error: 'VAEA_ENABLED=false' });
    return;
  }
  try {
    const m = await runObservePass(getSupabase());
    res.json({ ok: true, metrics: m });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});

function startObserveLoop(): void {
  const flags = readFeatureFlags();
  if (!flags.vaeaEnabled || !flags.observeEnabled) {
    console.log(`[${VTID}] Observe loop disabled (vaeaEnabled=${flags.vaeaEnabled}, observeEnabled=${flags.observeEnabled})`);
    return;
  }

  const interval = Math.max(60_000, flags.observeIntervalMs);
  console.log(`[${VTID}] Starting observe loop — interval ${interval}ms`);

  const tick = async (): Promise<void> => {
    try {
      await runObservePass(getSupabase());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${VTID}] observe pass threw: ${msg}`);
    }
  };

  void tick();
  observeTimer = setInterval(() => {
    void tick();
  }, interval);
  if (typeof observeTimer.unref === 'function') observeTimer.unref();
}

async function main(): Promise<void> {
  console.log(`[${VTID}] VAEA Phase 1 starting...`);
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
      description: 'M2M referral agent — Phase 1 observe mode (detects, scores, drafts; no posting)',
      tier: 'service',
      role: 'economic-actor',
      sourcePath: 'services/vaea/',
      healthEndpoint: '/alive',
      metadata: { vtid: VTID, phase: 1 },
    });
  } catch (err) {
    console.warn(`[${VTID}] agents-registry self-registration failed (non-fatal):`, err);
  }

  startObserveLoop();

  const shutdown = (signal: string): void => {
    console.log(`[${VTID}] Received ${signal}, shutting down...`);
    if (observeTimer) clearInterval(observeTimer);
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
