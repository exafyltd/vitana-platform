import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to guard against ReDoS attacks on route matching
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ 
    id: req.params.projectId, 
    type: 'Project' 
  });
});

router.get('/:projectId/members/:memberId', (req: Request, res: Response) => {
  res.json({ 
    projectId: req.params.projectId, 
    memberId: req.params.memberId 
  });
});

export default router;