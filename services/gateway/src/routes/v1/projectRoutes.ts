import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply CVE mitigation middleware to limit path parameters
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ project: req.params.projectId });
});

router.post('/:projectId/members/:memberId', (req: Request, res: Response) => {
  res.status(200).json({ 
    project: req.params.projectId, 
    member: req.params.memberId 
  });
});

export default router;