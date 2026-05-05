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

  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'invalid payload' });
  }

  const { first_name, nickname } = parsed.data;

  if (first_name !== undefined) {
    const result = await upsertMemoryFact(
      userId,
      'user_first_name',
      first_name,
      'user_stated_via_settings'
    );
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: 'failed to save first_name' });
    }
  }

  if (nickname !== undefined) {
    const result = await upsertMemoryFact(
      userId,
      'user_nickname',
      nickname,
      'user_stated_via_settings'
    );
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: 'failed to save nickname' });
    }
  }

  return res.json({ ok: true });
});

export default router;