import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, type: 'project' });
});

router.get('/:projectId/members/:memberId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, memberId: req.params.memberId });
});

export default router;