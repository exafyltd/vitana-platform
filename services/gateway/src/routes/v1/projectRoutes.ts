import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, type: 'project' });
});

router.put('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ status: 'updated' });
});

export default router;