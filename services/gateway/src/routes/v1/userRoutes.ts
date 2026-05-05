import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the CVE mitigation middleware to prevent ReDoS vectors
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  return res.json({
    ok: true,
    data: { user_id: req.params.userId }
  });
});

export default router;