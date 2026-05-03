import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to prevent ReDoS from deeply nested or overly long path parameters
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.userId });
});

router.get('/:userId/settings/:settingId', (req: Request, res: Response) => {
  res.status(200).json({ 
    id: req.params.userId, 
    setting: req.params.settingId 
  });
});

export default router;