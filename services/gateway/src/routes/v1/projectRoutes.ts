import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply parameter limiting middleware to mitigate path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
    res.status(200).json({
        projectId: req.params.projectId,
        type: 'project',
        status: 'active'
    });
});

router.get('/:projectId/resources/:resourceId', (req: Request, res: Response) => {
    res.status(200).json({
        projectId: req.params.projectId,
        resourceId: req.params.resourceId,
        status: 'success'
    });
});

export default router;