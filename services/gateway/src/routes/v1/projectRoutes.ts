import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply path parameter limits to mitigate ReDoS (path-to-regexp CVE)
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId });
});

router.get('/:projectId/members/:memberId', (req: Request, res: Response) => {
  res.status(200).json({ 
    projectId: req.params.projectId, 
    memberId: req.params.memberId 
  });
});

export default router;