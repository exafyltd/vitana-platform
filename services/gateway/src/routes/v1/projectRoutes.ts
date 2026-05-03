import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation for ReDoS (CVE in path-to-regexp)
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.json({ projectId: req.params.projectId, type: 'project' });
});

router.post('/:projectId/members/:memberId', (req, res) => {
  res.json({ projectId: req.params.projectId, memberId: req.params.memberId, status: 'added' });
});

export default router;