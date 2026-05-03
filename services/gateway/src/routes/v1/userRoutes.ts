import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limits to mitigate path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ user: req.params.id });
});

router.post('/', (req: Request, res: Response) => {
  res.status(201).json({ status: 'created' });
});

export default router;