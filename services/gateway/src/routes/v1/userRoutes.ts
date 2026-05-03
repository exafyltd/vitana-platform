import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to protect against ReDoS (CVE mitigation)
// NOTE: All route files with path parameters should apply this middleware.
router.use(limitPathParams());

router.get('/', (req, res) => {
  res.status(200).json({ users: [] });
});

router.get('/:id', (req, res) => {
  res.status(200).json({ id: req.params.id });
});

router.put('/:id/profile/:profileId', (req, res) => {
  res.status(200).json({ 
    id: req.params.id, 
    profileId: req.params.profileId 
  });
});

export default router;