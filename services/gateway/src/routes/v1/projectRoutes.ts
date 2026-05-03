import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate ReDoS
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ projectId: req.params.projectId });
});

router.get('/:projectId/users/:userId', (req: Request, res: Response) => {
  res.json({ projectId: req.params.projectId, userId: req.params.userId });
});

export default router;