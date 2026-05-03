import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to mitigate path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.projectId, name: 'Sample Project' });
});

router.post('/:projectId/resources', (req: Request, res: Response) => {
  res.status(201).json({ projectId: req.params.projectId, created: true });
});

export default router;