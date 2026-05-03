import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limits to mitigate path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ 
    message: 'Project details',
    projectId: req.params.projectId 
  });
});

router.get('/:projectId/members/:memberId', (req: Request, res: Response) => {
  res.status(200).json({ 
    message: 'Project member',
    projectId: req.params.projectId,
    memberId: req.params.memberId
  });
});

export default router;