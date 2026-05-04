import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate ReDoS
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ message: 'Project details', projectId: req.params.projectId });
});

router.post('/', (req: Request, res: Response) => {
  res.status(201).json({ message: 'Project created' });
});

export default router;