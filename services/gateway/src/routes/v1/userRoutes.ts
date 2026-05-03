import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply path parameter limits to mitigate ReDoS (path-to-regexp CVE)
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.userId });
});

router.put('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ success: true, userId: req.params.userId });
});

export default router;