import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:id', async (req: Request, res: Response) => {
  return res.json({ ok: true, data: { id: req.params.id } });
});

export default router;