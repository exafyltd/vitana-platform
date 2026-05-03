import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to prevent ReDoS on routes with path parameters
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.projectId, type: 'project' });
});

router.get('/:projectId/settings', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.projectId, type: 'settings' });
});

export default router;