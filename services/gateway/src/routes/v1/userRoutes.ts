import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/', (req, res) => {
  res.status(200).json({ users: [] });
});

router.get('/:userId', (req, res) => {
  res.status(200).json({ userId: req.params.userId });
});

export default router;