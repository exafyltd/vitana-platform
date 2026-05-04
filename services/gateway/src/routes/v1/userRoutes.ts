import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate ReDoS
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ message: 'User details', id: req.params.id });
});

router.post('/', (req: Request, res: Response) => {
  res.status(201).json({ message: 'User created' });
});

export default router;