/**
 * VTID-01095: Daily Scheduler Gateway Routes
 *
 * Provides endpoints for triggering and monitoring the daily recompute pipeline.
 *
 * Endpoints:
 *   POST /api/v1/scheduler/daily-recompute - Trigger batch recompute
 *   GET  /api/v1/scheduler/daily-recompute/status - Get recompute status
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  processDailyRecomputeBatch,
  getDailyRecomputeStatus,
} from '../services/daily-recompute-service';

const router = Router();
const VTID = 'VTID-01095';

// Request validation schemas
const DailyRecomputeRequestSchema = z.object({
  tenant_id: z.string().uuid('tenant_id must be a valid UUID'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format'),
  limit_users: z.number().int().min(1).max(200).optional().default(200),
  cursor: z.string().uuid().nullable().optional(),
});

const StatusQuerySchema = z.object({
  tenant_id: z.string().uuid('tenant_id must be a valid UUID'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format'),
});

/**
 * POST /daily-recompute
 *
 * Triggers the daily recompute pipeline for a batch of users.
 *
 * Request body:
 * {
 *   "tenant_id": "uuid",
 *   "date": "YYYY-MM-DD",
 *   "limit_users": 200,    // optional, max 200
 *   "cursor": "uuid"       // optional, for pagination
 * }
 *
 * Response:
 * {
 *   "ok": true,
 *   "processed": 150,
 *   "next_cursor": "uuid" | null
 * }
 */
router.post('/daily-recompute', async (req: Request, res: Response) => {
  console.log(`[${VTID}] POST /scheduler/daily-recompute`);

  // Validate request
  const validation = DailyRecomputeRequestSchema.safeParse(req.body);

  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_FAILED',
      details: validation.error.errors,
    });
  }

  const { tenant_id, date, limit_users, cursor } = validation.data;

  try {
    const startTime = Date.now();

    const result = await processDailyRecomputeBatch({
      tenant_id,
      date,
      limit_users,
      cursor: cursor || null,
    });

    const elapsed_ms = Date.now() - startTime;

    console.log(
      `[${VTID}] Batch complete: processed=${result.processed}, skipped=${result.skipped}, failed=${result.failed}, elapsed=${elapsed_ms}ms`
    );

    return res.status(result.ok ? 200 : 207).json({
      ...result,
      elapsed_ms,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[${VTID}] Error processing batch:`, errorMessage);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage,
    });
  }
});

/**
 * GET /daily-recompute/status
 *
 * Get the status of daily recompute for a tenant+date.
 *
 * Query params:
 *   tenant_id: uuid
 *   date: YYYY-MM-DD
 *
 * Response:
 * {
 *   "ok": true,
 *   "date": "2025-12-31",
 *   "tenant_id": "uuid",
 *   "total_users": 500,
 *   "completed": 400,
 *   "in_progress": 50,
 *   "failed": 10,
 *   "last_cursor": "uuid"
 * }
 */
router.get('/daily-recompute/status', async (req: Request, res: Response) => {
  console.log(`[${VTID}] GET /scheduler/daily-recompute/status`);

  // Validate query params
  const validation = StatusQuerySchema.safeParse(req.query);

  if (!validation.success) {
    console.warn(`[${VTID}] Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_FAILED',
      details: validation.error.errors,
    });
  }

  const { tenant_id, date } = validation.data;

  try {
    const status = await getDailyRecomputeStatus(tenant_id, date);

    return res.status(200).json(status);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[${VTID}] Error getting status:`, errorMessage);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage,
    });
  }
});

/**
 * GET /health
 *
 * Health check endpoint for the scheduler routes.
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'scheduler',
    vtid: VTID,
    timestamp: new Date().toISOString(),
  });
});

export default router;
