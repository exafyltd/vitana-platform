import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ project: req.params.projectId });
});

router.get('/:projectId/settings/:settingId', (req: Request, res: Response) => {
  res.json({ project: req.params.projectId, setting: req.params.settingId });
});

export default router;