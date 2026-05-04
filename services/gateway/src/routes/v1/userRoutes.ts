import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.json({ user: req.params.id });
});

router.get('/:id/profile/:profileId', (req: Request, res: Response) => {
  res.json({ user: req.params.id, profile: req.params.profileId });
});

export default router;