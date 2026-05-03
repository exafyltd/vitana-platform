import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:id', (req, res) => {
  res.json({ id: req.params.id, type: 'user' });
});

export default router;