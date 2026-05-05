import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:userId', limitPathParams(), (req: Request, res: Response) => {
  res.json({ ok: true, data: { user_id: req.params.userId } });
});

export default router;