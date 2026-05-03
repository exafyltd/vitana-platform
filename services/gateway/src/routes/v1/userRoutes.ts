import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limit middleware to mitigate ReDoS
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.json({ id: req.params.id });
});

router.post('/', (req: Request, res: Response) => {
  res.json({ success: true });
});

export default router;