import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router({ mergeParams: true });

// Apply path parameter limits to mitigate ReDoS
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
    res.status(200).json({ message: 'User list' });
});

router.get('/:userId', (req: Request, res: Response) => {
    res.status(200).json({ user: req.params.userId });
});

router.get('/:userId/profile', (req: Request, res: Response) => {
    res.status(200).json({ user: req.params.userId, profile: true });
});

export default router;