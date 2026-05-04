import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ projectId: req.params.projectId, type: 'project' });
});

router.get('/:projectId/members/:memberId', (req: Request, res: Response) => {
  res.json({ projectId: req.params.projectId, memberId: req.params.memberId, type: 'project' });
});

export default router;