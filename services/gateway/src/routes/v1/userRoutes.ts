import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limits to all routes within this router
router.use(limitPathParams());

router.get('/:userId', (req: Request, res: Response) => {
  res.json({ ok: true, data: { id: req.params.userId } });
});

export default router;