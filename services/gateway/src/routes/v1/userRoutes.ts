import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router({ mergeParams: true });

// Apply mitigation middleware to restrict parameter counts and lengths
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ user: req.params.id });
});

export default router;