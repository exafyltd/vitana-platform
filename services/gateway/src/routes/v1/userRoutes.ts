import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to mitigate path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:id', (req, res) => {
  res.json({ id: req.params.id });
});

export default router;