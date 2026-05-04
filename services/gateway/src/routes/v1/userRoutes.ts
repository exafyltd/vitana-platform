import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limits to mitigate ReDoS vulnerability
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id });
});

router.get('/:id/profile', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, profile: true });
});

export default router;