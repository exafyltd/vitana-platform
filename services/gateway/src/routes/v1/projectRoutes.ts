import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limits to mitigate ReDoS vulnerability
router.use(limitPathParams(5, 200));

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId });
});

router.get('/:projectId/settings', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, settings: true });
});

export default router;