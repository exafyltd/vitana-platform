import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to mitigate CVE-202X-XXXX ReDoS in path-to-regexp
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