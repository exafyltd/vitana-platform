import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate ReDoS via excess/long params
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.json({ id: req.params.projectId });
});

export default router;