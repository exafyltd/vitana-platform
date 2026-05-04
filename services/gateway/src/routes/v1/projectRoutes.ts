import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to mitigate ReDoS vulnerability
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.status(200).json({
    projectId: req.params.projectId,
    type: 'project'
  });
});

router.get('/:projectId/members/:memberId', (req, res) => {
  res.status(200).json({
    projectId: req.params.projectId,
    memberId: req.params.memberId
  });
});

export default router;