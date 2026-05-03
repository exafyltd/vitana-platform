import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation middleware
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ user: req.params.id });
});

router.get('/:id/settings/:settingId', (req: Request, res: Response) => {
  res.status(200).json({ user: req.params.id, setting: req.params.settingId });
});

export default router;