import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation middleware to prevent path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, type: 'user' });
});

router.get('/:id/profile/:section', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, section: req.params.section });
});

export default router;