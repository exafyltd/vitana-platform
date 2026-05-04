import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.json({ projectId: req.params.projectId });
});

router.get('/:projectId/tasks/:taskId', (req, res) => {
  res.json({ projectId: req.params.projectId, taskId: req.params.taskId });
});

export default router;