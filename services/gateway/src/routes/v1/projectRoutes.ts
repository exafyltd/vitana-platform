import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router({ mergeParams: true });

// Apply path parameter limits to mitigate CVE-2024-4068 (ReDoS in path-to-regexp)
// Note: All other route files with path parameters must also apply this middleware.
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, message: 'Project fetched successfully' });
});

router.post('/', (req: Request, res: Response) => {
  res.status(201).json({ message: 'Project created' });
});

export default router;