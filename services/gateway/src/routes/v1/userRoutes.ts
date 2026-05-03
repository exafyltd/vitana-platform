import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to prevent ReDoS on routes with path parameters
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, type: 'user' });
});

router.get('/:id/profile', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, type: 'profile' });
});

export default router;