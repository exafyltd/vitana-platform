import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply parameter limit middleware to mitigate path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.json({ userId: req.params.userId });
});

router.get('/:userId/profile', (req, res) => {
  res.json({ userId: req.params.userId, profile: true });
});

export default router;