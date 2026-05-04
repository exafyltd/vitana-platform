import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply middleware to mitigate path-to-regexp ReDoS vulnerability on subsequent routes
router.use(limitPathParams());

// Representative route with a path parameter
router.get('/:projectId', (req, res) => {
  res.json({ projectId: req.params.projectId, message: 'Project detail' });
});

export default router;