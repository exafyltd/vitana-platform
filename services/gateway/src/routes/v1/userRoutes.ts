import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply parameter limit middleware to protect against ReDoS
router.use(limitPathParams());

// Example user routes
router.get('/:userId', (req, res) => {
  res.json({ id: req.params.userId, status: 'success' });
});

router.get('/:userId/profile', (req, res) => {
  res.json({ id: req.params.userId, profile: {} });
});

export default router;