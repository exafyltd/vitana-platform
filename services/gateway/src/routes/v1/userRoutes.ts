import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.status(200).json({ user: req.params.userId });
});

router.get('/:userId/profile', (req, res) => {
  res.status(200).json({ profile: req.params.userId });
});

export default router;