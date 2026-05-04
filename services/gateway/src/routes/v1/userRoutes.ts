import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.json({ id: req.params.userId, type: 'user' });
});

router.put('/:userId/settings/:settingId', (req, res) => {
  res.json({ success: true });
});

export default router;