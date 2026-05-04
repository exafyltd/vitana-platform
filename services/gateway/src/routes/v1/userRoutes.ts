import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.json({ userId: req.params.userId });
});

router.get('/:userId/profile', (req, res) => {
  res.json({ userId: req.params.userId, profile: true });
});

export default router;