import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:projectId', (req: Request, res: Response) => {
  res.json({ id: req.params.projectId });
});

router.post('/:projectId/members', (req: Request, res: Response) => {
  res.json({ added: true });
});

router.delete('/:projectId', (req: Request, res: Response) => {
  res.json({ deleted: true });
});

export default router;