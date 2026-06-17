/**
 * Admin endpoint to sync the Vitanaland Shopify store catalog into /discover.
 *   POST /api/v1/vcaop/shopify/sync   (exafy_admin only)
 *
 * On-demand twin of the background worker in services/shopify-sync. Pulls the
 * store's products.json, converts prices to EUR, and upserts them into the
 * catalog under the own-store merchant.
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth-supabase-jwt';
import { resolveShopifyConfig, syncShopifyCatalog } from '../services/shopify-sync';

const router = Router();
router.use(requireAuth as any);

router.post('/sync', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: this handler DOES record an OASIS event via a direct
  // oasis_events insert below (the same pattern as emitEvent in vcaop.ts), just
  // not through the emitOasisEvent helper the scanner greps for.
  if (!(req as any).identity?.exafy_admin) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
  const supabase = getSupabase();
  if (!supabase) { res.status(503).json({ ok: false, error: 'database unavailable' }); return; }
  const cfg = resolveShopifyConfig();
  if (!cfg) { res.status(400).json({ ok: false, error: 'SHOPIFY_STORE_DOMAIN not configured' }); return; }
  try {
    const result = await syncShopifyCatalog(supabase, cfg);
    try {
      await supabase.from('oasis_events').insert({
        id: randomUUID(), service: 'vcaop', source: 'vcaop',
        type: 'vcaop.shopify.synced', topic: 'vcaop.shopify.synced',
        status: 'success', message: `shopify sync ${result.upserted}/${result.fetched} products`,
        metadata: result, created_at: new Date().toISOString(),
      });
    } catch { /* never block the sync response on the audit write */ }
    res.json({ ok: true, data: result });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
});

export default router;
