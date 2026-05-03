import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply middleware to restrict maximum parameters and parameter length
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.id });
});

router.post('/', (req: Request, res: Response) => {
  res.status(201).json({ created: true });
});

export default router;