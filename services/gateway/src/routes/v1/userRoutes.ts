import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.status(200).json({ userId: req.params.userId, type: 'user' });
});

router.post('/', (req, res) => {
  res.status(201).json({ status: 'created' });
});

export default router;