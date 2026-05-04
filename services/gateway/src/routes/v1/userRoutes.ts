import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation middleware to restrict parameter counts and lengths
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.userId, type: 'user' });
});

router.get('/:userId/profile/:profileId', (req: Request, res: Response) => {
  res.status(200).json({ 
    userId: req.params.userId, 
    profileId: req.params.profileId 
  });
});

export default router;