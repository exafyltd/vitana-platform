import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the middleware to abort execution before downstream route evaluation 
// if the path segments are pathologically long.
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  return res.json({ ok: true, data: { id: req.params.id } });
});

router.get('/:id/settings/:settingId', (req: Request, res: Response) => {
  return res.json({ ok: true, data: { id: req.params.id, settingId: req.params.settingId } });
});

export default router;