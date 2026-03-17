/**
 * Webhook Handler - HTTP channel for Vitana backend to trigger OpenClaw tasks.
 *
 * Accepts POST requests from the Vitana backend with structured goals,
 * routes them through the governance pipeline, executes via skills,
 * and optionally calls back to a provided URL.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { executeWithGovernance, emitOasisEvent, validateTenantScope } from './oasis-bridge';
import { executeSkillAction, listSkills, hasSkillAction } from '../skills';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const WebhookPayloadSchema = z.object({
  /** Tenant making the request */
  tenant_id: z.string().uuid(),
  /** Natural language goal or structured skill+action */
  goal: z.string().min(1).max(5000),
  /** Optional callback URL for async results */
  callback: z.string().url().optional(),
  /** Optional: explicit skill to invoke */
  skill: z.string().optional(),
  /** Optional: explicit action within the skill */
  action: z.string().optional(),
  /** Optional: input data for the skill action */
  input: z.record(z.unknown()).optional(),
  /** Optional: VTID to associate with this execution */
  vtid: z.string().optional(),
});

type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

async function sendCallback(callbackUrl: string, result: unknown): Promise<void> {
  try {
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'openclaw-bridge',
        timestamp: new Date().toISOString(),
        result,
      }),
    });
  } catch (err) {
    console.error(`[webhook] Callback to ${callbackUrl} failed:`, err);
  }
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

export function createWebhookRouter(): Router {
  const router = Router();

  /**
   * POST /vitana-webhook
   * Main entry point for Vitana backend to trigger OpenClaw tasks.
   */
  router.post('/', async (req: Request, res: Response) => {
    // Parse and validate
    const parsed = WebhookPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid payload',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const payload: WebhookPayload = parsed.data;
    const requestId = crypto.randomUUID();

    // Validate tenant
    try {
      validateTenantScope(payload.tenant_id);
    } catch {
      res.status(400).json({ error: 'Invalid tenant_id' });
      return;
    }

    // If explicit skill+action provided, execute directly
    if (payload.skill && payload.action) {
      if (!hasSkillAction(payload.skill, payload.action)) {
        res.status(404).json({
          error: `Skill action not found: ${payload.skill}.${payload.action}`,
          available_skills: listSkills(),
        });
        return;
      }

      // Acknowledge immediately, process async
      res.status(202).json({
        request_id: requestId,
        status: 'accepted',
        skill: payload.skill,
        action: payload.action,
      });

      // Execute with governance
      try {
        const result = await executeWithGovernance({
          skill: payload.skill,
          action: payload.action,
          tenant_id: payload.tenant_id,
          input: { ...payload.input, tenant_id: payload.tenant_id },
          goal: payload.goal,
          executeAction: (input) => executeSkillAction(payload.skill!, payload.action!, input),
        });

        if (payload.callback) {
          await sendCallback(payload.callback, {
            request_id: requestId,
            ...result,
          });
        }
      } catch (err) {
        if (payload.callback) {
          await sendCallback(payload.callback, {
            request_id: requestId,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return;
    }

    // Goal-based routing (no explicit skill) - queue for OpenClaw planning
    res.status(202).json({
      request_id: requestId,
      status: 'accepted',
      message: 'Goal queued for OpenClaw planning',
      goal: payload.goal,
    });

    await emitOasisEvent({
      type: 'openclaw.goal_received',
      tenant_id: payload.tenant_id,
      vtid: payload.vtid,
      payload: {
        request_id: requestId,
        goal: payload.goal,
        callback: payload.callback,
      },
    });
  });

  /**
   * GET /vitana-webhook/health
   * Health check endpoint.
   */
  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'openclaw-bridge',
      timestamp: new Date().toISOString(),
      skills: listSkills(),
    });
  });

  /**
   * GET /vitana-webhook/skills
   * List available skills and their actions.
   */
  router.get('/skills', (_req: Request, res: Response) => {
    res.json({ skills: listSkills() });
  });

  return router;
}
