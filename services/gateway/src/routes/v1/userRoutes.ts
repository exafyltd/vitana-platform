import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the ReDoS mitigation middleware to all routes in this router
router.use(limitPathParams());

router.get('/:id', (req, res) => {
    res.status(200).json({ id: req.params.id, type: 'user' });
});

router.put('/:id', (req, res) => {
    res.status(200).json({ id: req.params.id, updated: true });
});

export default router;