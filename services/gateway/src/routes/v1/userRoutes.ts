import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate path-to-regexp ReDoS
router.use(limitPathParams(5, 200));

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ user: req.params.id });
});

router.put('/:id/profile/:profileId', (req: Request, res: Response) => {
  res.status(200).json({ user: req.params.id, profile: req.params.profileId });
});

export default router;