import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to protect against ReDoS (CVE mitigation)
// NOTE: All route files with path parameters should apply this middleware.
router.use(limitPathParams());

router.get('/', (req, res) => {
  res.status(200).json({ projects: [] });
});

router.get('/:projectId', (req, res) => {
  res.status(200).json({ id: req.params.projectId });
});

router.post('/:projectId/members/:memberId', (req, res) => {
  res.status(201).json({ 
    projectId: req.params.projectId, 
    memberId: req.params.memberId 
  });
});

export default router;