import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to protect against path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.status(200).json({ userId: req.params.userId, message: 'User profile retrieved' });
});

router.put('/:userId/settings/:settingId', (req, res) => {
  res.status(200).json({ message: 'User settings updated' });
});

export default router;