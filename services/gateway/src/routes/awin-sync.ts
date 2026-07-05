/**
 * Admin endpoints for the Awin integration (exafy_admin only):
 *   POST /api/v1/vcaop/awin/sync               harvest joined programmes
 *   POST /api/v1/vcaop/awin/conversions/sync   pull + credit conversions (Phase 2)
 *
 * On-demand twins of the background workers in services/awin-sync and
 * services/awin-conversions.
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth-supabase-jwt';
import { resolveAwinConfig, syncAwinProgrammes } from '../services/awin-sync';
import { resolveAwinTxConfig, creditAwinConversions } from '../services/awin-conversions';

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

router.post('/conversions/sync', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: creditAwinConversions records reward.<state> OASIS rows
  // via a direct oasis_events insert (same pattern as emitEvent in vcaop.ts), not
  // via the emitOasisEvent helper the scanner greps for.
  if (!(req as any).identity?.exafy_admin) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
  const supabase = getSupabase();
  if (!supabase) { res.status(503).json({ ok: false, error: 'database unavailable' }); return; }
  const cfg = resolveAwinTxConfig();
  if (!cfg) { res.status(400).json({ ok: false, error: 'AWIN_PUBLISHER_ID / AWIN_API_TOKEN not configured' }); return; }
  try {
    const result = await creditAwinConversions(supabase, cfg);
    try {
      await supabase.from('oasis_events').insert({
        id: randomUUID(), service: 'vcaop', source: 'vcaop',
        topic: 'vcaop.awin.conversions_synced',
        status: 'success', message: `awin conversions ${result.credited} credited / ${result.attributed} attributed / ${result.fetched} pulled`,
        metadata: result, created_at: new Date().toISOString(),
      });
    } catch { /* never block the response on the audit write */ }
    res.json({ ok: true, data: result });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
});

export default router;
