import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Apply ReDoS mitigation middleware
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
    res.status(200).json({ message: 'User details', id: req.params.id });
});

export default router;