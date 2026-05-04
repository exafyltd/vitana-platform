import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to mitigate ReDoS CVE
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id });
});

router.put('/:id', (req: Request, res: Response) => {
  res.status(200).json({ updated: true });
});

export default router;