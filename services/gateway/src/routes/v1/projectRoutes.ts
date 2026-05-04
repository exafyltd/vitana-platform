import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to protect all project routes against ReDoS
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId });
});

router.put('/:projectId/settings/:key', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId, key: req.params.key });
});

export default router;