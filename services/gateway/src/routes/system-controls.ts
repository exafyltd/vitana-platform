import { Router, Request, Response } from 'express';
import { getSystemControl } from '../services/system-controls';

const router = Router();

router.get('/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const control = await getSystemControl(key);

    if (!control) {
      return res.status(404).json({ error: 'System control not found' });
    }

    res.json(control);
  } catch (error) {
    console.error('Error fetching system control:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;