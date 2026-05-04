import { Router, RequestHandler } from 'express';
import { getSystemControl } from '../services/system-controls';

const router = Router();

const getSystemControlHandler: RequestHandler = async (req, res, next) => {
  try {
    const { key } = req.params;
    const control = await getSystemControl(key);

    if (!control) {
      res.status(404).json({ error: 'System control not found' });
      return;
    }

    res.json(control);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};

router.get('/:key', getSystemControlHandler);

export default router;