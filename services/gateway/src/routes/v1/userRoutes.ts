import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation middleware against ReDoS vulnerabilities
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({ users: [] });
});

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, type: 'user' });
});

router.get('/:id/profile/:profileId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, profileId: req.params.profileId });
});

export default router;