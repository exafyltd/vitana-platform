import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.json({ id: req.params.userId, type: 'user' });
});

router.post('/:userId/roles/:roleId', (req: Request, res: Response) => {
  res.json({ user: req.params.userId, role: req.params.roleId });
});

export default router;