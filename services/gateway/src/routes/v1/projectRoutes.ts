import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate path-to-regexp ReDoS
// Note: All route files with path parameters should apply this middleware.
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, name: 'Sample Project' });
});

router.post('/:projectId/members/:memberId', (req: Request, res: Response) => {
  res.status(200).json({ 
    projectId: req.params.projectId, 
    memberId: req.params.memberId,
    added: true 
  });
});

export default router;