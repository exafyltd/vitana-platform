import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limits to mitigate path-to-regexp ReDoS vulnerability
router.use(limitPathParams());

router.get('/:userId', async (req: Request, res: Response) => {
  return res.json({ 
    ok: true, 
    data: { userId: req.params.userId } 
  });
});

export default router;