import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware for all parameterized routes in this router
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
    res.status(200).json({
        id: req.params.projectId,
        resource: 'project'
    });
});

router.get('/:projectId/tasks/:taskId', (req: Request, res: Response) => {
    res.status(200).json({
        projectId: req.params.projectId,
        taskId: req.params.taskId
    });
});

export default router;