import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limits to protect against path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.json({ projectId: req.params.projectId });
});

export default router;