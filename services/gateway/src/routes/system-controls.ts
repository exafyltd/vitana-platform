import { Router, Request, Response, NextFunction } from 'express';
import { getSystemControl } from '../services/system-controls';

const router = Router();

router.get('/:key', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { key } = req.params;
    const control = await getSystemControl(key);

    if (!control) {
      res.status(404).json({ error: 'System control not found' });
      return;
    }

    res.json(control);
  } catch (error) {
    next(error);
  }
});

export default router;