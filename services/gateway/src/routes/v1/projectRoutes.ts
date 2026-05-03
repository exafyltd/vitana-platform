import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the paramLimit middleware to prevent path-to-regexp ReDoS
// NOTE: All route files with path parameters should apply this middleware.
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, type: 'project' });
});

export default router;