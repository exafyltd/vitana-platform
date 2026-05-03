import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply middleware to limit path parameters and prevent ReDoS
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId });
});

router.get('/:projectId/users/:userId', (req: Request, res: Response) => {
  res.status(200).json({ 
    projectId: req.params.projectId, 
    userId: req.params.userId 
  });
});

export default router;