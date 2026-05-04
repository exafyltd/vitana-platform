import { Router, Request, Response } from 'express';
import { getSystemControl } from '../services/system-controls';

export const systemControlsRouter = Router();

systemControlsRouter.get('/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const control = await getSystemControl(key);

    if (!control) {
      res.status(404).json({ error: 'System control not found' });
      return;
    }

    res.json(control);
  } catch (error) {
    console.error(`Error fetching system control ${req.params.key}:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});