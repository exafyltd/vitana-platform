import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply middleware to restrict maximum parameters and parameter length
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId });
});

router.post('/', (req: Request, res: Response) => {
  res.status(201).json({ created: true });
});

export default router;