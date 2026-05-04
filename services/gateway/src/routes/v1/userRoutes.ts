import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.status(200).json({ id: req.params.userId });
});

router.get('/:userId/posts/:postId', (req, res) => {
  res.status(200).json({ userId: req.params.userId, postId: req.params.postId });
});

export default router;