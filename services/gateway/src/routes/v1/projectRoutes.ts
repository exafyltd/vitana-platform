import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply parameter limiting middleware to protect against path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.json({ projects: [] });
});

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ project: req.params.projectId });
});

router.post('/:projectId/members/:memberId', (req: Request, res: Response) => {
  res.json({ added: true, project: req.params.projectId, member: req.params.memberId });
});

export default router;