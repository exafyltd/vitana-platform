import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, type: 'project' });
});

router.post('/:projectId/settings/:settingId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, settingId: req.params.settingId, updated: true });
});

export default router;