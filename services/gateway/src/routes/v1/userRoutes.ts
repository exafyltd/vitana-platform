import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply CVE mitigation middleware to prevent ReDoS via excessive parameters
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({ message: 'User list' });
});

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ userId: req.params.id });
});

router.get('/:id/settings/:settingId', (req: Request, res: Response) => {
  res.status(200).json({ 
    userId: req.params.id, 
    settingId: req.params.settingId 
  });
});

export default router;