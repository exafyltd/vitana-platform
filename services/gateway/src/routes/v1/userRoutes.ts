import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({ users: [] });
});

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.userId });
});

router.put('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ updated: true });
});

export default router;