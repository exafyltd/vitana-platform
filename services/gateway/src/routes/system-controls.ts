import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { getSystemControl } from '../services/system-controls';

const router = Router();

router.get('/:key', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  const { key } = req.params;
  if (!key) {
    return res.status(400).json({ ok: false, error: 'missing key parameter' });
  }

  const result = await getSystemControl(supabase, key);
  
  if (!result.ok) {
    if (result.error === 'Not found') {
      return res.status(404).json({ ok: false, error: 'system control not found' });
    }
    return res.status(500).json({ ok: false, error: result.error });
  }

  return res.json({ ok: true, data: result.data });
});

export default router;