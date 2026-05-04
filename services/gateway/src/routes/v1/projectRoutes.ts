import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.json({ message: 'Project details fetched', projectId: req.params.projectId });
});

router.post('/:projectId/members/:memberId', (req, res) => {
  res.json({ 
    message: 'Project member added', 
    projectId: req.params.projectId, 
    memberId: req.params.memberId 
  });
});

export default router;