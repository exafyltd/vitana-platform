import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// NOTE: All route files with path parameters should apply this limitPathParams middleware 
// to mitigate the path-to-regexp ReDoS vulnerability.
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, type: 'project' });
});

router.post('/:projectId/members', (req: Request, res: Response) => {
  res.status(201).json({ projectId: req.params.projectId, memberAdded: true });
});

export default router;