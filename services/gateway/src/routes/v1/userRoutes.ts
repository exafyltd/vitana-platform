import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply CVE mitigation middleware to limit path parameters
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ user: req.params.id });
});

router.put('/:id', (req: Request, res: Response) => {
  res.status(200).json({ updated: req.params.id });
});

export default router;