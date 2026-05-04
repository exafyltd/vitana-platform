import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to protect all user routes against ReDoS
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.id });
});

router.post('/:id/actions/:action', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.id, action: req.params.action });
});

export default router;