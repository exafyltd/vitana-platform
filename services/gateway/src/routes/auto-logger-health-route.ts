import { Router, Request, Response } from 'express';
import { autoLoggerMetrics } from '../services/auto-logger-metrics';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  try {
    const snapshot = autoLoggerMetrics.getSnapshot();
    const status = snapshot.failed > 0 && snapshot.sent === 0 ? 'degraded' : 'ok';
    res.json({ status, lastTelemetryAt: snapshot.lastTelemetryAt, metrics: { sent: snapshot.sent, failed: snapshot.failed, template_missing: snapshot.template_missing } });
  } catch (error) {
    console.error('[AutoLoggerHealth] Error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to generate health report' });
  }
});

export default router;
