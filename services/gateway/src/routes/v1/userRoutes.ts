import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for ReDoS vulnerability in path-to-regexp
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, type: 'user' });
});

router.get('/:userId/settings', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.userId, type: 'user', settings: {} });
});

export default router;