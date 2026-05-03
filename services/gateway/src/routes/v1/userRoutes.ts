import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply limitPathParams middleware to mitigate ReDoS vulnerabilities.
// NOTE: All route files with path parameters must apply this middleware!
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ user: req.params.userId });
});

export default router;