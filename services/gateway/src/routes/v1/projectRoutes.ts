import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware to strictly limit path parameter count and lengths
router.use(limitPathParams());

router.get('/:projectId', async (req: Request, res: Response) => {
  return res.json({ 
    ok: true, 
    data: { projectId: req.params.projectId } 
  });
});

router.get('/:projectId/resources/:resourceId', async (req: Request, res: Response) => {
  return res.json({
    ok: true,
    data: {
      projectId: req.params.projectId,
      resourceId: req.params.resourceId
    }
  });
});

export default router;