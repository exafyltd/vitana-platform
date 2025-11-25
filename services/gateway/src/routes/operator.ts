/**
 * Operator Chat Route
 * DEV-AICOR-0027: Operator Chat Backend Fix
 */

import { Router, Request, Response } from 'express';
import { operatorService } from '../services/operator-service';

const router = Router();

router.post('/api/v1/operator/chat', async (req: Request, res: Response) => {
  try {
    const { message, vtid } = req.body || {};

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        error: true,
        message: 'message is required and must be a string'
      });
    }

    if (vtid && typeof vtid !== 'string') {
      return res.status(400).json({
        error: true,
        message: 'vtid must be a string if provided'
      });
    }

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      return res.status(400).json({
        error: true,
        message: 'message cannot be empty'
      });
    }

    const result = await operatorService.processOperatorMessage(trimmedMessage, vtid);
    return res.status(200).json(result);

  } catch (error: any) {
    console.error('[Operator Chat] Error:', error);
    return res.status(500).json({
      error: true,
      message: error?.message || 'Internal server error in operator chat'
    });
  }
});

router.get('/api/v1/operator/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    service: 'operator',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    vtid: 'DEV-AICOR-0027'
  });
});

export default router;
