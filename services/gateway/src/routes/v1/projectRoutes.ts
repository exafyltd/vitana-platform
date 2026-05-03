import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// NOTE: All route files with path parameters should apply this middleware
// to mitigate the path-to-regexp ReDoS vulnerability (CVE).
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ project: req.params.projectId });
});

export default router;