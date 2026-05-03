import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware for path parameters
router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.status(200).json({ userId: req.params.userId });
});

router.post('/', (req, res) => {
  res.status(201).json({ status: 'created' });
});

export default router;