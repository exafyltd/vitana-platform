import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate path-to-regexp ReDoS
// Note: All route files with path parameters should apply this middleware.
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, name: 'Sample User' });
});

router.put('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, updated: true });
});

export default router;