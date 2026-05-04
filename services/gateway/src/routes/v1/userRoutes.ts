import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.json({ id: req.params.id, message: 'User details' });
});

router.post('/', (req: Request, res: Response) => {
  res.status(201).json({ message: 'User created' });
});

export default router;