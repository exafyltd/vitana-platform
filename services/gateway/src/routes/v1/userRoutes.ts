import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.json({ id: req.params.id, type: 'user' });
});

router.put('/:id', (req: Request, res: Response) => {
  res.json({ id: req.params.id, status: 'updated' });
});

export default router;