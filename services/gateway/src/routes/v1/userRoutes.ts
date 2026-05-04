import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', resource: 'users' });
});

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.userId });
});

router.get('/:userId/projects/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.userId, projectId: req.params.projectId });
});

export default router;