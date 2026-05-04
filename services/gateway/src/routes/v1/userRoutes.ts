import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.json({ id: req.params.id, type: 'user' });
});

router.get('/:id/settings/:settingId', (req: Request, res: Response) => {
  res.json({ id: req.params.id, settingId: req.params.settingId, type: 'user' });
});

export default router;