import { Router } from 'express';
import { getSystemControl } from '../services/system-controls';

export const systemControlsRouter = Router();

systemControlsRouter.get('/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    const control = await getSystemControl(key);

    if (!control) {
      return res.status(404).json({ error: 'System control not found' });
    }

    return res.json(control);
  } catch (error) {
    next(error);
  }
});