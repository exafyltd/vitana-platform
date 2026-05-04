import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.json({ user: req.params.id });
});

router.get('/:userId/posts/:postId', (req: Request, res: Response) => {
  res.json({ userId: req.params.userId, postId: req.params.postId });
});

export default router;