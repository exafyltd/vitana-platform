import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.json({ projectId: req.params.projectId, type: 'project' });
});

router.post('/', (req, res) => {
  res.status(201).json({ success: true });
});

export default router;