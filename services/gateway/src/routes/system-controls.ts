import { Router, Request, Response, NextFunction } from 'express';
import { getSystemControl } from '../services/system-controls';

const router = Router();

router.get('/:key', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { key } = req.params;
    
    // Safety check ensuring we only process string keys
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'Invalid system control key' });
    }

    const control = await getSystemControl(key);

    if (!control) {
      return res.status(404).json({ error: 'System control not found' });
    }

    return res.json(control);
  } catch (error) {
    next(error);
  }
});

export default router;