import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// NOTE: This middleware must be applied to all route files containing path parameters 
// to mitigate path-to-regexp ReDoS (CVE-2024-XXXX).
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.userId });
});

router.get('/:userId/profile', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.userId, profile: 'details' });
});

export default router;