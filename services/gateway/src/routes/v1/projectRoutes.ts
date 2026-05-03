import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.json({ projects: [] });
});

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ projectId: req.params.projectId, type: 'project' });
});

router.get('/:projectId/tasks/:taskId', (req: Request, res: Response) => {
  res.json({ projectId: req.params.projectId, taskId: req.params.taskId });
});

export default router;