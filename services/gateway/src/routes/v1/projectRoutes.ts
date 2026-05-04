import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ id: req.params.projectId, type: 'project' });
});

router.put('/:projectId/members/:memberId', (req: Request, res: Response) => {
  res.json({ project: req.params.projectId, member: req.params.memberId });
});

export default router;