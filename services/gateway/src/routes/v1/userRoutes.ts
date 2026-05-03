import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to prevent ReDoS on all routes in this file
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.json({ id: req.params.userId, type: 'user' });
});

router.post('/:userId/actions/:actionName', (req: Request, res: Response) => {
  res.json({ id: req.params.userId, action: req.params.actionName });
});

export default router;