import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router({ mergeParams: true });

// Apply parameter limit middleware to mitigate ReDoS vulnerabilities
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({ projects: [] });
});

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.projectId });
});

router.get('/:projectId/tasks/:taskId', (req: Request, res: Response) => {
  res.status(200).json({ 
    projectId: req.params.projectId, 
    taskId: req.params.taskId 
  });
});

export default router;