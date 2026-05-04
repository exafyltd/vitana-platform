import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware for all parameterized routes in this router
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
    res.status(200).json({
        id: req.params.userId,
        resource: 'user'
    });
});

router.get('/:userId/profile', (req: Request, res: Response) => {
    res.status(200).json({
        id: req.params.userId,
        type: 'profile'
    });
});

export default router;