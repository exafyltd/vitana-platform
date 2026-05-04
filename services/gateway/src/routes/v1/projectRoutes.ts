import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.status(200).json({ id: req.params.projectId });
});

router.get('/:projectId/tasks/:taskId', (req, res) => {
  res.status(200).json({ projectId: req.params.projectId, taskId: req.params.taskId });
});

export default router;