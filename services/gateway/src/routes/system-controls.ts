import { Router, Request, Response } from 'express';
import { getSystemControl } from '../services/system-controls';

const router = Router();

router.get('/:key', async (req: Request, res: Response): Promise<void> => {
  try {
    const { key } = req.params;
    const control = await getSystemControl(key);

    if (!control) {
      res.status(404).json({ error: 'System control not found' });
      return;
    }

    res.status(200).json(control);
  } catch (error) {
    console.error('Error in system-controls route:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;