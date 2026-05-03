import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to guard against ReDoS attacks on route matching
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.json({ 
    id: req.params.userId, 
    type: 'User' 
  });
});

router.get('/:userId/profile/:profileId', (req: Request, res: Response) => {
  res.json({ 
    userId: req.params.userId, 
    profileId: req.params.profileId 
  });
});

export default router;