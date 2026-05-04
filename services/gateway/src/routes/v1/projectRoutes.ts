import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the param limit middleware to mitigate CVE (ReDoS in path-to-regexp)
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ id: req.params.projectId, type: 'project' });
});

router.get('/:projectId/members', (req: Request, res: Response) => {
  res.json({ id: req.params.projectId, members: [] });
});

export default router;