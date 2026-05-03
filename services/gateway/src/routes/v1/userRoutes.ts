import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation middleware for ReDoS vulnerability
router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.status(200).json({ id: req.params.userId });
});

router.post('/:userId/roles', (req, res) => {
  res.status(201).json({ success: true });
});

export default router;