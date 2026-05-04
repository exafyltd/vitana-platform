import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id });
});

router.put('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, updated: true });
});

export default router;