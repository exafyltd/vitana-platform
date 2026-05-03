import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for ReDoS (CVE in path-to-regexp)
router.use(limitPathParams());

router.get('/:id', (req, res) => {
  res.json({ id: req.params.id, type: 'user' });
});

router.get('/:id/settings/:settingId', (req, res) => {
  res.json({ id: req.params.id, settingId: req.params.settingId, type: 'user-setting' });
});

export default router;