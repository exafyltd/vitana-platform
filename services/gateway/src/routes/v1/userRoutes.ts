import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply parameter limiting middleware to prevent ReDoS via excessive parameters
router.use(limitPathParams());

router.get('/:userId', async (req: Request, res: Response) => {
  return res.json({ 
    ok: true, 
    data: { 
      userId: req.params.userId 
    } 
  });
});

export default router;