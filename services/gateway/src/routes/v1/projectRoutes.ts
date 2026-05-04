import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({ projects: [] });
});

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId });
});

export default router;