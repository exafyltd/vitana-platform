import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to prevent ReDoS on path-to-regexp
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.json({ id: req.params.projectId });
});

export default router;