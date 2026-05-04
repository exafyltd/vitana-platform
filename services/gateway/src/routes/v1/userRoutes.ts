import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/', (req: Request, res: Response) => {
  res.status(200).json({ message: 'Users index' });
});

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, message: 'User details' });
});

router.get('/:id/settings/:settingId', (req: Request, res: Response) => {
  res.status(200).json({ 
    id: req.params.id, 
    settingId: req.params.settingId 
  });
});

export default router;