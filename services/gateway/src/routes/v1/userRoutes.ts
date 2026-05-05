import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply CVE mitigation middleware to prevent path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:userId', async (req: Request, res: Response) => {
  return res.json({ 
    ok: true, 
    data: { user_id: req.params.userId } 
  });
});

router.get('/:userId/settings/:settingId', async (req: Request, res: Response) => {
  return res.json({ 
    ok: true, 
    data: { 
      user_id: req.params.userId,
      setting_id: req.params.settingId
    } 
  });
});

export default router;