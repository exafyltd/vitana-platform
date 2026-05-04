import { Router } from 'express';
import { limitPathParams } from '../middleware/paramLimit';

const router = Router();

router.use(limitPathParams());

router.get('/:id', (req, res) => {
  res.json({ id: req.params.id, type: 'user' });
});

router.post('/', (req, res) => {
  res.status(201).json({ success: true });
});

router.get('/:id/profile/:profileId', (req, res) => {
  res.json({ id: req.params.id, profileId: req.params.profileId });
});

export default router;