import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply middleware to protect against path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, type: 'user' });
});

router.get('/:id/settings/:settingId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, setting: req.params.settingId });
});

export default router;