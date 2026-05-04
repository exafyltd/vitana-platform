import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.json({ id: req.params.userId, type: 'user' });
});

router.get('/:userId/profile', (req, res) => {
  res.json({ id: req.params.userId, type: 'profile' });
});

router.put('/:userId', (req, res) => {
  res.json({ id: req.params.userId, status: 'updated' });
});

export default router;