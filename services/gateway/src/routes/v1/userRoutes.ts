import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({ users: [] });
});

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.userId, type: 'user' });
});

router.get('/:userId/profile', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.userId, profile: {} });
});

export default router;