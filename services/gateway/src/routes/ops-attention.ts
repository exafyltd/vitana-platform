/**
 * VTID-04876 — GET /api/v1/ops/attention: the Command Hub Overview's
 * supervisor cockpit feed (plan A, Phase 1).
 *
 * Platform exafy_admin only (requireAdminAuth, plan F3): tenant admins never
 * see cross-tenant operations data. Read-only apart from the gateway's own
 * ops_attention_state bookkeeping (service role). Computed on demand while a
 * viewer has the Overview open, single-flight + 25 s cache per task
 * (services/ops-attention.ts). The Overview is a triage surface; GChat (SNS)
 * stays the paging channel.
 *
 * Response: { ok, data: { generated_at, env, verdict, counts, sources, items,
 * domains (VTID-04885), hidden, timeline, sparklines, acks_error (VTID-04886) } }.
 *
 * VTID-04886 (Phase 3) — Ack / Snooze, plan REVISION 2 F5:
 *   POST /api/v1/ops/attention/ack     { fingerprint, reason, duration_minutes, vtid? }
 *   POST /api/v1/ops/attention/snooze  { fingerprint, reason, duration_minutes, vtid? }
 * requireAdminAuth, Zod-validated. The reason is required and the expiry is
 * at most 24 h. The fingerprint must be an item that is open now, in this
 * env; its severity is read from the current computation, never from the
 * client. P1 is ackable but never snoozable (400 p1_not_snoozable). Each
 * action writes ops_attention_acks and emits ops.attention.acked /
 * ops.attention.snoozed to OASIS.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAdminAuth, type AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import {
  ACK_MAX_MINUTES,
  getOpsAttention,
  recordOpsAttentionAction,
  type AckAction,
} from '../services/ops-attention';

const router = Router();

router.get('/', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    const { data, cached } = await getOpsAttention({ authHeader });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, data, cached });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ops-attention] failed:', message);
    return res.status(500).json({ ok: false, error: 'attention_failed', data: null });
  }
});

// ── VTID-04886: Ack / Snooze ────────────────────────────────────────────────

export const AckBodySchema = z
  .object({
    fingerprint: z.string().trim().min(3).max(300),
    reason: z.string().trim().min(3, 'reason is required (at least 3 characters)').max(500),
    duration_minutes: z.number().int().min(5).max(ACK_MAX_MINUTES),
    vtid: z
      .string()
      .trim()
      .regex(/^VTID-\d{4,5}$/, 'vtid must look like VTID-01234')
      .optional()
      .nullable(),
  })
  .strict();

function handler(action: AckAction) {
  return async (req: AuthenticatedRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const parsed = AckBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_body',
        data: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
    }
    try {
      const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
      const out = await recordOpsAttentionAction({
        action,
        fingerprint: parsed.data.fingerprint,
        reason: parsed.data.reason,
        durationMinutes: parsed.data.duration_minutes,
        vtid: parsed.data.vtid ?? null,
        actor: { user_id: req.identity?.user_id ?? null, email: req.identity?.email ?? null },
        authHeader,
      });
      if (!out.ok) return res.status(out.status).json({ ok: false, error: out.error, data: null });
      return res.status(201).json({ ok: true, data: out.data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ops-attention] ${action} failed:`, message);
      return res.status(500).json({ ok: false, error: `${action}_failed`, data: null });
    }
  };
}

router.post('/ack', requireAdminAuth, handler('ack'));
router.post('/snooze', requireAdminAuth, handler('snooze'));

export default router;
