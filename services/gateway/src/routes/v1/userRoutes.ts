import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:id', (req, res) => {
  res.status(200).json({ id: req.params.id });
});

export default router;