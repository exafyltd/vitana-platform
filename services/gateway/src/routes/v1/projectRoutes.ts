import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/', (req, res) => {
  res.json({ projects: [] });
});

router.get('/:id', (req, res) => {
  res.json({ id: req.params.id, type: 'project' });
});

router.get('/:projectId/settings/:settingId', (req, res) => {
  res.json({ project: req.params.projectId, setting: req.params.settingId });
});

export default router;