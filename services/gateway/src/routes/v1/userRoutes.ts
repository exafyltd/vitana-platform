import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to prevent ReDoS on paths with parameters
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.json({ user: req.params.id });
});

router.get('/:id/posts/:postId', (req: Request, res: Response) => {
  res.json({ user: req.params.id, post: req.params.postId });
});

export default router;