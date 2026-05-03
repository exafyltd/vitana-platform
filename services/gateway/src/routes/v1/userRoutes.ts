import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware to all user routes
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.json({ users: [] });
});

router.get('/:userId', (req: Request, res: Response) => {
  res.json({ user: req.params.userId });
});

router.get('/:userId/posts/:postId', (req: Request, res: Response) => {
  res.json({ user: req.params.userId, post: req.params.postId });
});

router.put('/:userId', (req: Request, res: Response) => {
  res.json({ updated: req.params.userId });
});

router.delete('/:userId', (req: Request, res: Response) => {
  res.status(204).send();
});

export default router;