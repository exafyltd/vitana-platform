/**
 * VTID-02000 / VTID-01930: Internal sync trigger endpoint for the scheduler.
 *
 * Separate from /api/v1/admin/marketplace/sync which requires a tenant-admin
 * JWT — that's a dead-end for machine-to-machine cron. This endpoint is
 * authed by a shared secret header and has no user context.
 *
 * Used by:
 *   - .github/workflows/MARKETPLACE-SYNC-CRON.yml — daily at 03:00 UTC
 *   - Manual `curl -H 'X-Scheduler-Secret: $MARKETPLACE_SYNC_SECRET' ...`
 *     when an operator wants to force-run outside the schedule
 *
 * The supported networks come from the provider registry — adding Amazon,
 * Rakuten, etc. requires no changes here.
 *
 * Any request without a matching X-Scheduler-Secret header returns 401.
 * If MARKETPLACE_SYNC_SECRET is not configured on the gateway, all requests
 * return 500 (fail closed — never run sync without auth).
 */

import { Router, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';

const router = Router();

function secretMatches(provided: string | undefined): boolean {
  const configured = process.env.MARKETPLACE_SYNC_SECRET;
  if (!configured || !provided) return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

router.post('/sync/:network', async (req: Request, res: Response) => {
  if (!process.env.MARKETPLACE_SYNC_SECRET) {
    res.status(500).json({ ok: false, error: 'MARKETPLACE_SYNC_SECRET not configured on gateway' });
    return;
  }
  const headerSecret = req.headers['x-scheduler-secret'];
  const provided = Array.isArray(headerSecret) ? headerSecret[0] : headerSecret;
  if (!secretMatches(provided)) {
    res.status(401).json({ ok: false, error: 'invalid or missing X-Scheduler-Secret' });
    return;
  }

  const network = req.params.network;
  const { providerKeys } = await import('../services/marketplace-sync/providers');
  const supported = providerKeys();

  if (network !== 'all' && !supported.includes(network)) {
    res.status(400).json({
      ok: false,
      error: `Unsupported network: ${network}. Use one of: ${['all', ...supported].join(', ')}.`,
    });
    return;
  }

  try {
    const { runMarketplaceSyncSource, runAllMarketplaceSync } = await import('../services/marketplace-sync');
    const triggeredBy = 'scheduler';
    const startedAt = Date.now();

    if (network === 'all') {
      const result = await runAllMarketplaceSync(triggeredBy);
      const summary = Object.entries(result.providers)
        .map(([k, v]) => `${k}=${JSON.stringify(v.totals)}`)
        .join(' ');
      console.log(`[marketplace-sync-scheduler] all done in ${Date.now() - startedAt}ms ${summary}`);
      res.json({ ok: true, network: 'all', duration_ms: Date.now() - startedAt, result });
      return;
    }

    const result = await runMarketplaceSyncSource(network, triggeredBy);
    console.log(`[marketplace-sync-scheduler] ${network} done in ${Date.now() - startedAt}ms`, result.totals);
    res.json({ ok: true, network, duration_ms: Date.now() - startedAt, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[marketplace-sync-scheduler] failed:', message);
    res.status(500).json({ ok: false, error: message });
  }
});

export default router;
