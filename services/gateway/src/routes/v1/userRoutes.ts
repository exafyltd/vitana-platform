import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to prevent ReDoS on path-to-regexp
router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.json({ id: req.params.userId });
});

export default router;