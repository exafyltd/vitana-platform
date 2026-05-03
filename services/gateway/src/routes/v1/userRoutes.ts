import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply mitigation middleware for ReDoS vulnerability
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
    res.json({ id: req.params.id, type: 'user' });
});

router.get('/:id/profile', (req: Request, res: Response) => {
    res.json({ id: req.params.id, profile: true });
});

export default router;