import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.json({ message: 'User profile fetched', userId: req.params.userId });
});

router.put('/:userId/settings', (req, res) => {
  res.json({ message: 'User settings updated', userId: req.params.userId });
});

export default router;