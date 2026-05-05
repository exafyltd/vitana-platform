import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { upsertMemoryFact } from '../services/memory-facts';

const router = Router();

const updateProfileSchema = z.object({
  first_name: z.string().optional(),
  nickname: z.string().optional(),
});

router.patch('/profile', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const parseResult = updateProfileSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ 
      ok: false, 
      error: 'invalid payload', 
      details: parseResult.error.format() 
    });
  }

  const { first_name, nickname } = parseResult.data;

  if (first_name !== undefined) {
    const result = await upsertMemoryFact(userId, 'user_first_name', first_name, 'user_stated_via_settings');
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }
  }

  if (nickname !== undefined) {
    const result = await upsertMemoryFact(userId, 'user_nickname', nickname, 'user_stated_via_settings');
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }
  }

  return res.json({ ok: true, data: { success: true } });
});

export default router;