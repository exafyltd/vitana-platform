import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router({ mergeParams: true });

// Apply parameter limit middleware to mitigate ReDoS vulnerabilities
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({ users: [] });
});

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.userId });
});

router.get('/:userId/profile', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.userId, type: 'profile' });
});

export default router;