import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation middleware against ReDoS vulnerabilities
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({ projects: [] });
});

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, type: 'project' });
});

router.post('/:projectId/members/:memberId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, memberId: req.params.memberId });
});

export default router;