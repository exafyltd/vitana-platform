import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply the ReDoS mitigation middleware to all routes in this router
router.use(limitPathParams());

router.get('/:projectId', (req, res) => {
    res.status(200).json({ projectId: req.params.projectId, type: 'project' });
});

router.delete('/:projectId', (req, res) => {
    res.status(200).json({ projectId: req.params.projectId, deleted: true });
});

export default router;