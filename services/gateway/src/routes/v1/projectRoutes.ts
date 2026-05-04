import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply CVE mitigation middleware to prevent ReDoS via excessive parameters
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({ message: 'Project list' });
});

router.get('/:projectId', (req: Request, res: Response) => {
  res.status(200).json({ projectId: req.params.projectId });
});

export default router;