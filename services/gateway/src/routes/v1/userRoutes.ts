import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply param limits to protect against path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:id', (req, res) => {
  res.json({ id: req.params.id });
});

router.get('/:id/settings/:settingId', (req, res) => {
  res.json({ id: req.params.id, settingId: req.params.settingId });
});

export default router;