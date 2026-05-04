import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate ReDoS via excess/long params
router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.json({ id: req.params.userId });
});

export default router;