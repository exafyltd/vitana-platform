import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware to all project routes
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.json({ projects: [] });
});

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ project: req.params.projectId });
});

router.get('/:projectId/tasks/:taskId', (req: Request, res: Response) => {
  res.json({ project: req.params.projectId, task: req.params.taskId });
});

router.post('/:projectId/members/:memberId', (req: Request, res: Response) => {
  res.json({ project: req.params.projectId, memberAdded: req.params.memberId });
});

export default router;