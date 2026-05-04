import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Note: All route files with path parameters should apply this middleware
// to mitigate the path-to-regexp ReDoS vulnerability.
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.userId });
});

export default router;