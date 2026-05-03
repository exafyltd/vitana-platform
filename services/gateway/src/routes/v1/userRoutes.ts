import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to mitigate path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.userId, name: 'Sample User' });
});

router.put('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.userId, updated: true });
});

export default router;