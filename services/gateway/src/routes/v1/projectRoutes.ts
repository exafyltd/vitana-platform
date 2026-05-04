import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ id: req.params.projectId, type: 'project' });
});

router.post('/:projectId/members', (req: Request, res: Response) => {
  res.json({ id: req.params.projectId, status: 'member_added' });
});

export default router;