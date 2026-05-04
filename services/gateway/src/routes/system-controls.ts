import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { getSystemControl } from '../services/system-controls';

const router = Router();

const systemControlParamsSchema = z.object({
  key: z.string().min(1, 'missing key parameter'),
});

router.get('/:key', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'no supabase' });
  }

  const parsed = systemControlParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'missing key parameter' });
  }

  const { key } = parsed.data;

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