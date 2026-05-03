import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router({ mergeParams: true });

// Apply mitigation for ReDoS vulnerability in path-to-regexp
router.use(limitPathParams());

router.get('/', (req, res) => {
  res.status(200).json({ projects: [] });
});

router.get('/:projectId', (req, res) => {
  res.status(200).json({ projectId: req.params.projectId });
});

export default router;