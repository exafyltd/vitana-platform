import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to mitigate ReDoS vulnerabilities
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId });
});

router.post('/:projectId/members/:userId', (req: Request, res: Response) => {
  res.status(200).json({ 
    projectId: req.params.projectId, 
    userId: req.params.userId 
  });
});

export default router;