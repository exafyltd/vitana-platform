import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to prevent ReDoS on all routes in this router
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({ projects: [] });
});

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.projectId, type: 'project' });
});

router.post('/', (req: Request, res: Response) => {
  res.status(201).json({ success: true });
});

export default router;