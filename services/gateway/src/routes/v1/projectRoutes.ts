import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.json({ id: req.params.projectId, type: 'project' });
});

router.post('/:projectId/members/:memberId', (req, res) => {
  res.json({ success: true });
});

export default router;