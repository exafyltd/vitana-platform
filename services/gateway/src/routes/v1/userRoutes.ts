import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:userId', (req, res) => {
    res.json({ id: req.params.userId, type: 'user' });
});

export default router;