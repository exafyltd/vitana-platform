import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for ReDoS vulnerability in path-to-regexp
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.json({ users: [] });
});

router.get('/:id', (req: Request, res: Response) => {
  res.json({ id: req.params.id, type: 'user' });
});

router.put('/:id', (req: Request, res: Response) => {
  res.json({ id: req.params.id, updated: true });
});

export default router;