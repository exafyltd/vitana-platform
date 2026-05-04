import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the parameter limiting middleware to prevent ReDoS
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ projectId: req.params.projectId, message: 'Project details' });
});

router.put('/:projectId', (req: Request, res: Response) => {
  res.json({ projectId: req.params.projectId, message: 'Project updated' });
});

export default router;