import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';
import { requireAuth } from '../../middleware/auth-supabase-jwt';

const router = Router();

// Applied globally for the router context as specified
router.use(limitPathParams());

router.get('/', requireAuth, async (req: Request, res: Response) => {
  return res.json({ ok: true, data: { users: [] } });
});

// Applied locally to ensure req.params is fully populated during Express routing phase
router.get('/:userId', requireAuth, limitPathParams(), async (req: Request, res: Response) => {
  return res.json({ ok: true, data: { user_id: req.params.userId } });
});

router.get('/:userId/settings/:settingId', requireAuth, limitPathParams(), async (req: Request, res: Response) => {
  return res.json({
    ok: true,
    data: {
      user_id: req.params.userId,
      setting_id: req.params.settingId
    }
  });
});

export default router;