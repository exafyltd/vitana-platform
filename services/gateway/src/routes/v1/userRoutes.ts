import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply parameter limiting middleware to mitigate path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
    res.status(200).json({
        id: req.params.id,
        type: 'user',
        status: 'active'
    });
});

router.get('/:id/settings/:settingId', (req: Request, res: Response) => {
    res.status(200).json({
        id: req.params.id,
        settingId: req.params.settingId,
        status: 'success'
    });
});

export default router;