import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ projectId: req.params.projectId, message: 'Project details' });
});

router.get('/:projectId/members/:memberId', (req: Request, res: Response) => {
  res.json({ 
    projectId: req.params.projectId, 
    memberId: req.params.memberId 
  });
});

export default router;