import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.projectId, type: 'project' });
});

router.put('/:projectId/settings/:settingId', (req: Request, res: Response) => {
  res.status(200).json({ status: 'updated' });
});

router.post('/', (req: Request, res: Response) => {
  res.status(201).json({ status: 'created' });
});

export default router;