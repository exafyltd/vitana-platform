import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for ReDoS in path-to-regexp parsing
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({ projects: [] });
});

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ 
    id: req.params.projectId, 
    title: 'Placeholder Project' 
  });
});

router.get('/:projectId/tasks/:taskId', (req: Request, res: Response) => {
  res.status(200).json({ 
    projectId: req.params.projectId, 
    taskId: req.params.taskId,
    status: 'pending' 
  });
});

export default router;