import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router({ mergeParams: true });

// Apply path parameter limits to mitigate CVE-2024-4068 (ReDoS in path-to-regexp)
// Note: All other route files with path parameters must also apply this middleware.
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, message: 'User fetched successfully' });
});

router.post('/', (req: Request, res: Response) => {
  res.status(201).json({ message: 'User created' });
});

export default router;