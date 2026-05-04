import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.status(200).json({ project: req.params.projectId });
});

router.get('/:projectId/settings', (req, res) => {
  res.status(200).json({ settings: req.params.projectId });
});

export default router;