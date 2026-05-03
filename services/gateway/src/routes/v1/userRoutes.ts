import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limits to mitigate path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ 
    message: 'User details',
    userId: req.params.id 
  });
});

router.get('/:id/settings/:settingId', (req: Request, res: Response) => {
  res.status(200).json({ 
    message: 'User setting',
    userId: req.params.id,
    settingId: req.params.settingId
  });
});

export default router;