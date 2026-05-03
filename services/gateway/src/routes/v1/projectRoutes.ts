import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.json({ id: req.params.projectId, type: 'project' });
});

router.get('/:projectId/members/:memberId', (req, res) => {
  res.json({ projectId: req.params.projectId, memberId: req.params.memberId });
});

export default router;