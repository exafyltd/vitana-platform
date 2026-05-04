import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for ReDoS (CVE in path-to-regexp)
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.json({ id: req.params.projectId, type: 'project' });
});

router.get('/:projectId/tasks/:taskId', (req, res) => {
  res.json({ projectId: req.params.projectId, taskId: req.params.taskId });
});

export default router;