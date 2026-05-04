import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/', (req, res) => {
  res.json({ users: [] });
});

router.get('/:id', (req, res) => {
  res.json({ id: req.params.id, type: 'user' });
});

router.get('/:id/profile', (req, res) => {
  res.json({ id: req.params.id, profile: {} });
});

export default router;