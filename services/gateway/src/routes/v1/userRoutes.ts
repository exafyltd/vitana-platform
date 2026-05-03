import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limits to mitigate path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.json({ users: [] });
});

router.get('/:id', (req: Request, res: Response) => {
  res.json({ id: req.params.id, type: 'user' });
});

export default router;