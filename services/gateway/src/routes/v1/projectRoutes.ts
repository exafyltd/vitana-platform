import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply CVE mitigation middleware to prevent path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:projectId', async (req: Request, res: Response) => {
  return res.json({ 
    ok: true, 
    data: { project_id: req.params.projectId } 
  });
});

router.get('/:projectId/members/:memberId', async (req: Request, res: Response) => {
  return res.json({ 
    ok: true, 
    data: { 
      project_id: req.params.projectId,
      member_id: req.params.memberId
    } 
  });
});

export default router;