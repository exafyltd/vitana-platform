import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router({ mergeParams: true });

router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ user: req.params.id });
});

router.get('/:id/profile', (req: Request, res: Response) => {
  res.status(200).json({ profile: req.params.id });
});

export default router;