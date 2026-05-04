import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for ReDoS vulnerability in path-to-regexp
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.json({ projects: [] });
});

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ projectId: req.params.projectId, type: 'project' });
});

export default router;