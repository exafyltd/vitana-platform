/**
 * Admin endpoint: harvest joined Awin programmes into affiliate_program.
 *   POST /api/v1/vcaop/awin/sync   (exafy_admin only)
 *
 * On-demand twin of the background worker in services/awin-sync. Uses the Awin
 * Publisher API to pull joined programmes and upsert them (cashback=true, with
 * the Awin cread.php deeplink base + clickref SubID).
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth-supabase-jwt';
import { resolveAwinConfig, syncAwinProgrammes } from '../services/awin-sync';

const router = Router();
router.use(requireAuth as any);

router.post('/sync', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: this handler records an OASIS event via the direct
  // oasis_events insert below (same pattern as emitEvent in vcaop.ts), not via
  // the emitOasisEvent helper the scanner greps for.
  if (!(req as any).identity?.exafy_admin) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
  const supabase = getSupabase();
  if (!supabase) { res.status(503).json({ ok: false, error: 'database unavailable' }); return; }
  const cfg = resolveAwinConfig();
  if (!cfg) { res.status(400).json({ ok: false, error: 'AWIN_PUBLISHER_ID / AWIN_API_TOKEN not configured' }); return; }
  try {
    const result = await syncAwinProgrammes(supabase, cfg);
    try {
      await supabase.from('oasis_events').insert({
        id: randomUUID(), service: 'vcaop', source: 'vcaop',
        type: 'vcaop.awin.synced', topic: 'vcaop.awin.synced',
        status: 'success', message: `awin sync ${result.upserted}/${result.fetched} programmes`,
        metadata: result, created_at: new Date().toISOString(),
      });
    } catch { /* never block the sync response on the audit write */ }
    res.json({ ok: true, data: result });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
});

export default router;
