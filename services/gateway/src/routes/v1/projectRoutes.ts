import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the ReDoS mitigation middleware
router.use(limitPathParams(5, 200));

router.get('/:id', (req: Request, res: Response) => {
  return res.json({ 
    ok: true, 
    data: { 
      id: req.params.id,
      entity: 'project'
    } 
  });
});

// A route deliberately containing multiple parameters to ensure tests can trigger limits
router.get('/:a/:b/:c/:d/:e/:f', (req: Request, res: Response) => {
  return res.json({ 
    ok: true, 
    data: { 
      message: 'This should not be reached when exceeding max params' 
    } 
  });
});

export default router;