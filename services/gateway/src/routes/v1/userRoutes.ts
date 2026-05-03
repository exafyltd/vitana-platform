import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ id: req.params.id, message: 'User profile retrieved' });
});

router.get('/:id/profile/:section', (req: Request, res: Response) => {
  res.status(200).json({ 
    id: req.params.id, 
    section: req.params.section, 
    message: 'User section retrieved' 
  });
});

export default router;