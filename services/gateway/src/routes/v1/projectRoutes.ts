import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply limitPathParams middleware to mitigate ReDoS vulnerabilities.
// NOTE: All route files with path parameters must apply this middleware!
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ project: req.params.projectId });
});

export default router;