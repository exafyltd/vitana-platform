import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to prevent ReDoS from deeply nested or overly long path parameters
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.projectId });
});

router.get('/:projectId/members/:memberId', (req: Request, res: Response) => {
  res.status(200).json({ 
    project: req.params.projectId, 
    member: req.params.memberId 
  });
});

export default router;