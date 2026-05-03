import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to prevent ReDoS on all routes in this file
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ projectId: req.params.projectId, type: 'project' });
});

router.delete('/:projectId/environments/:envId', (req: Request, res: Response) => {
  res.json({ projectId: req.params.projectId, envId: req.params.envId });
});

export default router;