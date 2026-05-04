import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.json({ id: req.params.projectId, type: 'project' });
});

router.get('/:projectId/members/:memberId', (req, res) => {
  res.json({ project: req.params.projectId, member: req.params.memberId });
});

router.post('/:projectId/resources', (req, res) => {
  res.status(201).json({ project: req.params.projectId, status: 'created' });
});

export default router;