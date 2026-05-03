import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation middleware for ReDoS vulnerability
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.status(200).json({ id: req.params.projectId });
});

router.put('/:projectId/settings', (req, res) => {
  res.status(200).json({ updated: true });
});

export default router;