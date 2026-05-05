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
      entity: 'user'
    } 
  });
});

export default router;