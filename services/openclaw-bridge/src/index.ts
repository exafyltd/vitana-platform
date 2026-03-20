/**
 * OpenClaw Bridge for Vitana Autopilot
 *
 * Entry point that starts the HTTP webhook server and heartbeat loop.
 * Integrates OpenClaw's skill system with Vitana's OASIS governance pipeline.
 *
 * Architecture:
 *   Vitana Backend → Webhook → OASIS Bridge → Skills → Supabase/Stripe/Daily
 *                                    ↓
 *                              Governance Check
 *                                    ↓
 *                              PHI Redaction
 *                                    ↓
 *                              OASIS Events
 */

import express from 'express';
import { loadConfig } from './config/openclaw-config';
import { createWebhookRouter } from './bridge/webhook';
import { startHeartbeat, stopHeartbeat } from './bridge/heartbeat';
import { emitOasisEvent } from './bridge/oasis-bridge';
import { listSkills } from './skills';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();

  console.log('=== Vitana Autopilot (OpenClaw Bridge) ===');
  console.log(`Home: ${config.home}`);
  console.log(`LLM (default): ${config.llm.defaultProvider}/${config.llm.defaultModel}`);
  console.log(`LLM (health):  ${config.llm.healthProvider}/${config.llm.healthModel}`);
  console.log(`Workspace:     ${config.workspace.isolation}`);
  console.log(`Disabled:      ${config.disabledSkills.join(', ')}`);
  console.log(`Governance:    ${config.oasis.enforceGovernance ? 'ENFORCED' : 'BYPASSED'}`);
  console.log(`Skills:        ${listSkills().map((s) => s.name).join(', ')}`);

  // ---------------------------------------------------------------------------
  // HTTP Server
  // ---------------------------------------------------------------------------

  if (config.channel.enabled) {
    const app = express();
    app.use(express.json({ limit: '1mb' }));

    // Mount webhook router
    app.use(config.channel.path, createWebhookRouter());

    // Root health check (both /health and /alive for Cloud Run convention)
    const healthResponse = (_req: any, res: any) => {
      res.json({
        status: 'ok',
        service: 'openclaw-bridge',
        version: '0.1.0',
        uptime: process.uptime(),
      });
    };
    app.get('/health', healthResponse);
    app.get('/alive', healthResponse);

    app.listen(config.channel.port, () => {
      console.log(`[http] Listening on port ${config.channel.port}`);
      console.log(`[http] Webhook: http://localhost:${config.channel.port}${config.channel.path}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Heartbeat Loop
  // ---------------------------------------------------------------------------

  if (config.heartbeat.enabled) {
    startHeartbeat(config.heartbeat.intervalMs);
  }

  // ---------------------------------------------------------------------------
  // Startup Event
  // ---------------------------------------------------------------------------

  await emitOasisEvent({
    type: 'openclaw.bridge_started',
    payload: {
      version: '0.1.0',
      skills: listSkills().map((s) => s.name),
      heartbeat_enabled: config.heartbeat.enabled,
      heartbeat_interval_ms: config.heartbeat.intervalMs,
      governance_enforced: config.oasis.enforceGovernance,
    },
  }).catch((err) => {
    console.warn('[oasis] Startup event failed (non-fatal):', err.message);
  });

  // ---------------------------------------------------------------------------
  // Graceful Shutdown
  // ---------------------------------------------------------------------------

  const shutdown = async () => {
    console.log('\n[shutdown] Stopping OpenClaw Bridge...');
    stopHeartbeat();

    await emitOasisEvent({
      type: 'openclaw.bridge_stopped',
      payload: { reason: 'shutdown' },
    }).catch(() => {});

    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal error starting OpenClaw Bridge:', err);
  process.exit(1);
});
