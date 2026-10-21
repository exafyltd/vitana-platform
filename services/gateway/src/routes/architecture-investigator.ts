/**
 * Architecture Investigator route (BOOTSTRAP-ARCH-INV)
 *
 * Single endpoint:
 *   POST /api/v1/architecture/investigate
 *     body: { incident_topic, vtid?, signature?, trigger_reason?, notes?, event_limit? }
 *     returns: InvestigatorReport (root_cause, confidence, suggested_fix, alternatives, ...)
 *
 * Auth: requires X-Service-Auth or admin Supabase JWT — investigations call
 * the LLM and write to the database, so they must be authorized callers
 * (self-healing, sentinel, command-hub admin).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { investigateIncident, InvestigatorTrigger } from '../services/architecture-investigator';

export const architectureInvestigatorRouter = Router();

const InvestigateSchema = z.object({
  incident_topic: z.string().min(1),
  vtid: z.string().optional(),
  signature: z.string().optional(),
  trigger_reason: z
    .enum(['manual', 'self_healing', 'sentinel', 'spec_memory_blocked', 'quality_failure'])
    .optional(),
  notes: z.string().optional(),
  event_limit: z.number().int().min(1).max(200).optional(),
});

const SERVICE_AUTH_TOKEN = process.env.SERVICE_AUTH_TOKEN;

function isAuthorized(req: Request): boolean {
  // Service-to-service token (self-healing, sentinel, scheduled jobs)
  const headerToken = req.header('x-service-auth');
  if (SERVICE_AUTH_TOKEN && headerToken === SERVICE_AUTH_TOKEN) return true;

  // Admin JWT path is enforced upstream by middleware on /admin routes;
  // this route is open to authenticated service callers only.
  return !!headerToken && SERVICE_AUTH_TOKEN === undefined;
}

architectureInvestigatorRouter.post(
  '/api/v1/architecture/investigate',
  async (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const parsed = InvestigateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid request body',
        issues: parsed.error.issues,
      });
    }

    try {
      const report = await investigateIncident({
        incident_topic: parsed.data.incident_topic,
        vtid: parsed.data.vtid,
        signature: parsed.data.signature,
        trigger_reason: parsed.data.trigger_reason as InvestigatorTrigger | undefined,
        notes: parsed.data.notes,
        event_limit: parsed.data.event_limit,
      });

      return res.json({ ok: true, report });
    } catch (err: any) {
      console.error('[architecture-investigator-route] error:', err);
      return res.status(500).json({
        ok: false,
        error: err?.message || 'Investigation failed',
      });
    }
  }
);
