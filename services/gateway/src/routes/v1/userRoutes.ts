import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.json({ id: req.params.userId, type: 'user' });
});

router.get('/:userId/profile', (req, res) => {
  res.json({ id: req.params.userId, type: 'profile' });
});

export default router;