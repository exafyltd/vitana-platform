import { Router, Request, Response, NextFunction } from 'express';
import { getSystemControl } from '../services/system-controls';

export const systemControlsRouter = Router();

systemControlsRouter.get(
  '/:key',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { key } = req.params;
      
      if (!key) {
        return res.status(400).json({ error: 'System control key is required' });
      }

      const control = await getSystemControl(key);

      if (!control) {
        return res.status(404).json({ error: 'System control not found' });
      }

      return res.status(200).json(control);
    } catch (error) {
      next(error);
    }
  }
);