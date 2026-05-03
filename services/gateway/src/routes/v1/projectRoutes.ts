import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to prevent ReDoS from excessive or long path parameters.
// Note: Ensure this pattern is propagated to all route files with path parameters.
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.json({ projectId: req.params.projectId });
});

router.get('/:projectId/tasks/:taskId', (req, res) => {
  res.json({ projectId: req.params.projectId, taskId: req.params.taskId });
});

export default router;