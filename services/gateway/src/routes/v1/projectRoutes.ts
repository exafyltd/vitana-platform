import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the CVE mitigation middleware to prevent ReDoS via path parameters.
// NOTE: All route files with path parameters must apply this middleware.
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
    res.status(200).json({
        projectId: req.params.projectId,
        status: 'active'
    });
});

router.get('/:projectId/tasks/:taskId', (req: Request, res: Response) => {
    res.status(200).json({
        projectId: req.params.projectId,
        taskId: req.params.taskId
    });
});

export default router;