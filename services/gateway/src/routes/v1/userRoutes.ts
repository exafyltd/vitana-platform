import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to mitigate path-to-regexp ReDoS
router.use(limitPathParams(5, 200));

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, name: 'User Name' });
});

router.put('/:id', (req: Request, res: Response) => {
  res.status(200).json({ updated: true });
});

export default router;