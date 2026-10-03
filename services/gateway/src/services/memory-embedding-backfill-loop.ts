/**
 * VTID-04786: in-process trigger for AP-0910 (memory embedding backfill).
 *
 * AP-0910's only trigger was the GCP Cloud Scheduler, dead since July. The
 * general heartbeat loop cannot carry it: production does not run that loop
 * (turning the community automation engine live there is an owner decision),
 * and staging runs it in shadow mode, where runMemoryEmbeddingBackfill is
 * shadow-unsafe and never executes. This loop runs AP-0910 and nothing else.
 *
 * The job writes embeddings onto members' own memory rows. It sends nothing to
 * anyone, so it is not part of that decision.
 *
 * MEMORY_EMBEDDING_BACKFILL_LOOP_ENABLED=true (exact) plus
 * MEMORY_EMBEDDING_BACKFILL_TENANT_IDS (comma-separated) start it. It refuses
 * to start when AUTOMATIONS_DELIVERY_MODE resolves to shadow, so the flag
 * can never make staging write. Every gateway task runs the loop; the shared
 * automation_runs history lets only one of them run per interval.
 */

import { resolveAutomationDeliveryMode } from './automation-shadow';

export const BACKFILL_AUTOMATION_ID = 'AP-0910';
export const BACKFILL_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_TICK_MS = 5 * 60 * 1000;

export interface BackfillLoopConfig {
  enabled: boolean;
  tenantIds: string[];
  reason?: string;
}

export function resolveBackfillLoopConfig(
  env: Record<string, string | undefined> = process.env,
): BackfillLoopConfig {
  if (env.MEMORY_EMBEDDING_BACKFILL_LOOP_ENABLED !== 'true') {
    return { enabled: false, tenantIds: [], reason: 'MEMORY_EMBEDDING_BACKFILL_LOOP_ENABLED is not "true"' };
  }
  const tenantIds = (env.MEMORY_EMBEDDING_BACKFILL_TENANT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f-]{36}$/i.test(s));
  if (tenantIds.length === 0) {
    return { enabled: false, tenantIds: [], reason: 'MEMORY_EMBEDDING_BACKFILL_TENANT_IDS has no tenant id' };
  }
  if (resolveAutomationDeliveryMode(env) !== 'live') {
    return { enabled: false, tenantIds, reason: 'AUTOMATIONS_DELIVERY_MODE is shadow; the backfill writes, so it never runs here' };
  }
  return { enabled: true, tenantIds };
}

export interface BackfillDeps {
  latestRunAt: (tenantId: string) => Promise<string | null>;
  execute: (tenantId: string) => Promise<{ ok: boolean; skipped?: boolean; error?: string }>;
  now: () => number;
}

async function defaultDeps(): Promise<BackfillDeps> {
  const { getRunHistory, executeAutomation } = await import('./automation-executor');
  return {
    latestRunAt: async (tenantId) => {
      const [latest] = await getRunHistory(tenantId, BACKFILL_AUTOMATION_ID, 1);
      return latest?.started_at ?? null;
    },
    execute: (tenantId) =>
      executeAutomation(BACKFILL_AUTOMATION_ID, tenantId, 'heartbeat', 'embedding-backfill-loop'),
    now: () => Date.now(),
  };
}

/** One pass: run AP-0910 for each tenant whose last run is older than the interval. */
export async function runBackfillTick(
  tenantIds: string[],
  deps?: BackfillDeps,
): Promise<{ ran: string[]; skipped: string[]; failed: string[] }> {
  const d = deps ?? (await defaultDeps());
  const ran: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const tenantId of tenantIds) {
    const last = await d.latestRunAt(tenantId);
    const lastMs = last ? Date.parse(last) : 0;
    if (lastMs && d.now() - lastMs < BACKFILL_INTERVAL_MS) {
      skipped.push(tenantId);
      continue;
    }
    const r = await d.execute(tenantId);
    if (r.ok && !r.skipped) ran.push(tenantId);
    else if (!r.ok) failed.push(tenantId);
    else skipped.push(tenantId);
  }
  return { ran, skipped, failed };
}

let loopStarted = false;

export function startMemoryEmbeddingBackfillLoop(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const cfg = resolveBackfillLoopConfig(env);
  if (!cfg.enabled) {
    console.log(`⏸️ Memory embedding backfill loop not started: ${cfg.reason}`);
    return false;
  }
  if (loopStarted) return false;
  loopStarted = true;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runBackfillTick(cfg.tenantIds);
      if (r.ran.length || r.failed.length) {
        console.log(`[VTID-04786] embedding backfill ran=${r.ran.length} skipped=${r.skipped.length} failed=${r.failed.length}`);
      }
    } catch (err: any) {
      console.warn('[VTID-04786] embedding backfill tick error:', err?.message || err);
    } finally {
      running = false;
    }
  };

  // Tasks of one deploy boot together; the jitter keeps them from all
  // reading an empty history at the same instant.
  const jitterMs = Math.floor(Math.random() * 60_000);
  setTimeout(() => {
    void tick();
    setInterval(tick, DEFAULT_TICK_MS);
  }, 60_000 + jitterMs);
  console.log(`🧠 Memory embedding backfill loop started (AP-0910 every 30 min, tenants: ${cfg.tenantIds.length})`);
  return true;
}
