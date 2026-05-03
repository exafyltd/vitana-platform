import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware for path parameters
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
  res.status(200).json({ projectId: req.params.projectId });
});

router.put('/:projectId', (req, res) => {
  res.status(200).json({ status: 'updated' });
});

export default router;