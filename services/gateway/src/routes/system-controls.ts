import { Router } from 'express';
import { getSystemControl } from '../services/system-controls';

const router = Router();

router.get('/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    const control = await getSystemControl(key);

    if (!control) {
      return res.status(404).json({ error: 'System control not found' });
    }

    return res.json(control);
  } catch (err) {
    next(err);
  }
});

export default router;