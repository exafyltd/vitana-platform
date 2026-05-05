import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:userId', async (req: Request, res: Response) => {
  return res.json({ ok: true, data: { user_id: req.params.userId } });
});

export default router;