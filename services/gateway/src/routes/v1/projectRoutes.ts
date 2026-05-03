import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply parameter limit middleware to protect against ReDoS
router.use(limitPathParams());

// Example project routes
router.get('/:projectId', (req, res) => {
  res.json({ id: req.params.projectId, status: 'success' });
});

router.get('/:projectId/settings/:settingId', (req, res) => {
  res.json({ 
    project: req.params.projectId, 
    setting: req.params.settingId 
  });
});

export default router;