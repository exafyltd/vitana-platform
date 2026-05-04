import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({ message: 'Projects index' });
});

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, message: 'Project details' });
});

router.get('/:projectId/tasks/:taskId', (req: Request, res: Response) => {
  res.status(200).json({ 
    projectId: req.params.projectId, 
    taskId: req.params.taskId 
  });
});

export default router;