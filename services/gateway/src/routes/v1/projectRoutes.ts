import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation middleware for ReDoS
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, resource: 'Project' });
});

router.get('/:projectId/settings/:settingId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, settingId: req.params.settingId });
});

export default router;