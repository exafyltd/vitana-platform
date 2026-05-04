import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation at the router level. Note that req.params parsing happens at the route definition,
// but our middleware provides a fallback raw segment check for protection.
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
  res.json({ ok: true, data: { user_id: req.params.id } });
});

export default router;