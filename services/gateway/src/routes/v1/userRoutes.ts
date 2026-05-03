import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply paramLimit middleware to prevent ReDoS from excessive or long path parameters.
// Note: Ensure this pattern is propagated to all route files with path parameters.
router.use(limitPathParams());

router.get('/:userId', (req, res) => {
  res.json({ userId: req.params.userId });
});

router.get('/:userId/profile/:section', (req, res) => {
  res.json({ userId: req.params.userId, section: req.params.section });
});

export default router;