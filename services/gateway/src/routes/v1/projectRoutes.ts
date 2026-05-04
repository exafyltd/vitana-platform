import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// NOTE: This middleware must be applied to all route files containing path parameters 
// to mitigate path-to-regexp ReDoS (CVE-2024-XXXX).
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