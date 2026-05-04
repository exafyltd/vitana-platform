import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply parameter limiting middleware to protect against path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.json({ users: [] });
});

router.get('/:id', (req: Request, res: Response) => {
  res.json({ id: req.params.id });
});

router.get('/:id/profile/:profileId', (req: Request, res: Response) => {
  res.json({ id: req.params.id, profile: req.params.profileId });
});

router.post('/:id/actions/:actionId', (req: Request, res: Response) => {
  res.json({ id: req.params.id, action: req.params.actionId });
});

export default router;