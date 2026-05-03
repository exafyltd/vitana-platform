import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the paramLimit middleware to prevent path-to-regexp ReDoS
// NOTE: All route files with path parameters should apply this middleware.
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, type: 'user' });
});

router.get('/:id/settings/:settingId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, settingId: req.params.settingId });
});

export default router;