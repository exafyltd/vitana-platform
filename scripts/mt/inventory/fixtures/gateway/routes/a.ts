import { Router } from 'express';
const router = Router();
router.get('/open', async (req, res) => { res.json({}); });
router.post('/secure', requireAuth, async (req, res) => { res.json({}); });
router.delete('/admin/:id', requireAuth, requireTenantAdmin, handler);
export default router;
