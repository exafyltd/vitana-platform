import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply middleware to limit path parameters to prevent ReDoS
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.json({ id: req.params.id, type: 'user' });
});

router.get('/:userId/profile/:profileId', (req: Request, res: Response) => {
  res.json({ userId: req.params.userId, profileId: req.params.profileId });
});

export default router;