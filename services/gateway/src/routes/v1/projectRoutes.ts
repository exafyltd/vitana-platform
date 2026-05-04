import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router({ mergeParams: true });

// Apply path parameter limits to mitigate ReDoS
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
    res.status(200).json({ message: 'Project list' });
});

router.get('/:projectId', (req: Request, res: Response) => {
    res.status(200).json({ project: req.params.projectId });
});

router.get('/:projectId/members/:memberId', (req: Request, res: Response) => {
    res.status(200).json({ project: req.params.projectId, member: req.params.memberId });
});

export default router;