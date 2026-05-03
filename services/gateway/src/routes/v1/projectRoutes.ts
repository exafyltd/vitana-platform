import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to protect against path-to-regexp ReDoS
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.status(200).json({ projectId: req.params.projectId, message: 'Project details retrieved' });
});

router.post('/:projectId/members/:memberId', (req, res) => {
  res.status(200).json({ message: 'Member added to project' });
});

export default router;