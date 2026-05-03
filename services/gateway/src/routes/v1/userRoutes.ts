import { Router, Request, Response } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

// Note: All route files in services/gateway/src/routes/ with path parameters
// should apply this limitPathParams middleware to mitigate path-to-regexp ReDoS vulnerabilities.
router.use(limitPathParams());

router.get('/:id', (req: Request, res: Response) => {
    res.status(200).json({ userId: req.params.id });
});

export default router;