import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to mitigate ReDoS vulnerability
router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.status(200).json({
    userId: req.params.userId,
    type: 'user'
  });
});

router.get('/:userId/settings/:settingId', (req, res) => {
  res.status(200).json({
    userId: req.params.userId,
    settingId: req.params.settingId
  });
});

export default router;