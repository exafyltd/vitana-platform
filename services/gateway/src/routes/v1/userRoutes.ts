import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for ReDoS (CVE in path-to-regexp)
router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.json({ id: req.params.userId, type: 'user' });
});

router.post('/', (req, res) => {
  res.status(201).json({ status: 'created' });
});

export default router;