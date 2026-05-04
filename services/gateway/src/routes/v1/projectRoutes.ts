import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for ReDoS CVE
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ id: req.params.projectId, type: 'project' });
});

router.get('/:projectId/tasks/:taskId', (req: Request, res: Response) => {
  res.json({ id: req.params.projectId, taskId: req.params.taskId });
});

export default router;