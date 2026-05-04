import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the parameter limiting middleware to prevent ReDoS
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.json({ userId: req.params.userId, message: 'User details' });
});

router.post('/', (req: Request, res: Response) => {
  res.status(201).json({ success: true, message: 'User created' });
});

export default router;