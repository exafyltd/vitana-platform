import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.userId, type: 'user' });
});

router.get('/:userId/posts/:postId', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.userId, postId: req.params.postId });
});

export default router;