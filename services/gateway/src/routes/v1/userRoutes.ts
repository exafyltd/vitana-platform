import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, type: 'user' });
});

router.post('/', (req: Request, res: Response) => {
  res.status(201).json({ status: 'created' });
});

export default router;