import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// NOTE: All route files with path parameters should apply this middleware
// to mitigate the path-to-regexp ReDoS vulnerability (CVE).
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ user: req.params.userId });
});

export default router;