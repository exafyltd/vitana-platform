import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.json({ id: req.params.userId });
});

router.post('/', (req: Request, res: Response) => {
  res.status(201).json({ success: true });
});

router.put('/:userId', (req: Request, res: Response) => {
  res.json({ id: req.params.userId, updated: true });
});

router.get('/:userId/profile', (req: Request, res: Response) => {
  res.json({ id: req.params.userId, profile: true });
});

export default router;