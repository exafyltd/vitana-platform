import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation middleware for ReDoS
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.status(200).json({ id: req.params.projectId, type: 'project' });
});

router.get('/:projectId/users/:userId', (req, res) => {
  res.status(200).json({ 
    projectId: req.params.projectId, 
    userId: req.params.userId 
  });
});

export default router;