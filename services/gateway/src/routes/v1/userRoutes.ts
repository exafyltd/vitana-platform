import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for ReDoS in path-to-regexp parsing
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({ users: [] });
});

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ 
    id: req.params.userId, 
    name: 'Placeholder User' 
  });
});

router.get('/:userId/profile', (req: Request, res: Response) => {
  res.status(200).json({ 
    id: req.params.userId, 
    profileDetails: 'Details' 
  });
});

export default router;