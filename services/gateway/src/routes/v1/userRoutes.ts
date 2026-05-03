import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// NOTE: All route files with path parameters should apply this limitPathParams middleware 
// to mitigate the path-to-regexp ReDoS vulnerability.
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, type: 'user' });
});

router.put('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, updated: true });
});

export default router;