import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ projectId: req.params.projectId });
});

router.post('/', (req: Request, res: Response) => {
  res.status(201).json({ success: true });
});

router.delete('/:projectId', (req: Request, res: Response) => {
  res.json({ projectId: req.params.projectId, deleted: true });
});

router.get('/:projectId/settings', (req: Request, res: Response) => {
  res.json({ projectId: req.params.projectId, settings: true });
});

export default router;