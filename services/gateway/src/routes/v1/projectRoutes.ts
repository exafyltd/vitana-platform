import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to prevent ReDoS on paths with parameters
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ project: req.params.projectId });
});

router.get('/:projectId/tasks/:taskId', (req: Request, res: Response) => {
  res.json({ project: req.params.projectId, task: req.params.taskId });
});

export default router;