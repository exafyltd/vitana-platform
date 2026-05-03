import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

// Example route with a path parameter
router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id });
});

export default router;