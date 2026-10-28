/**
 * VTID-04473: Jev (TypeSafe System One) typed-decision API.
 *
 *   GET  /api/v1/jev/decisions           the decisions the caller may use
 *   POST /api/v1/jev/decisions/:name     one decision   { input }
 *   POST /api/v1/jev/documents/classify  back-office bulk relevance
 *                                        { query, documents: [{ id, title?, text }] }
 *   GET  /api/v1/jev/admin/stats         spend and outcomes since boot (exafy_admin)
 *
 * Access (owner decision 2026-09-25): professional, staff, backoffice, admin,
 * developer, infra and exafy_admin. Community and patient are refused until
 * cost control exists (JEV_COMMUNITY_ENABLED, never pinned). The role comes
 * from user_tenants.active_role for the caller's active tenant — never from
 * the request body.
 *
 * Inert until TypeSafe is configured (JEV_DECISIONS_ENABLED='true' and
 * TYPESAFE_API_KEY): decisions answer 503 `not_configured` and the caller
 * keeps its own path.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { decide, decideMany, JEV_MAX_BATCH, JevDecisionResult } from '../services/jev/jev-decision-service';
import { listJevDecisions } from '../services/jev/jev-decisions';
import { resolveJevAccess, roleMayUseDecision, isJevCommunityEnabled, JevCaller } from '../services/jev/jev-access';
import { isJevConfigured, jevModel } from '../services/jev/jev-client';
import { getJevStats } from '../services/jev/jev-telemetry';
import { resolveJevCaller, JevCallerError } from '../services/jev/jev-caller';
import { currentMonthUtc } from '../services/jev/jev-tenant-control';
import { fetchDevAutopilotKillSwitch, fetchMonthSpendRows, shadowGateStatsRpc } from '../services/jev/jev-repository';
import { JEV_HEALTH_MIN_DAYS, jevGateHealth } from '../services/jev/jev-shadow';

const router = Router();

// VTID-04754: caller resolution moved to services/jev/jev-caller.ts (canonical
// role, permitted-role check, tenant fallback, exafy_admin target tenant).
export { resolveJevCaller };

/** Resolves the caller or answers the request with the named refusal. */
async function callerOr(req: AuthenticatedRequest, res: Response): Promise<JevCaller | null> {
  try {
    return await resolveJevCaller(req);
  } catch (err: any) {
    if (err instanceof JevCallerError) {
      res.status(err.status).json({ ok: false, error: err.reason });
      return null;
    }
    console.warn('[jev] caller resolution failed:', err?.message || err);
    res.status(503).json({ ok: false, error: 'caller_resolution_failed' });
    return null;
  }
}

function sendResult(res: Response, r: JevDecisionResult): void {
  if (r.ok) {
    res.json({ ok: true, data: r });
    return;
  }
  res.status(r.status ?? 500).json({ ok: false, error: r.reason, detail: r.detail, data: r });
}

router.get('/jev/decisions', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const caller = await callerOr(req, res);
  if (!caller) return;
  const access = resolveJevAccess(caller);
  const decisions = access.allowed
    ? listJevDecisions()
        .filter((d) => roleMayUseDecision(access.role, d.roles))
        .map((d) => ({
          name: d.name,
          description: d.description,
          primary: d.primary,
          threshold: d.threshold,
          pii: d.pii,
          planes: d.planes,
          data: d.data,
          questions: Object.fromEntries(Object.entries(d.questions).map(([k, q]) => [k, { type: q.type, instructions: q.instructions }])),
        }))
    : [];
  res.json({
    ok: true,
    data: {
      configured: isJevConfigured(),
      model: jevModel(),
      access: access.allowed ? { allowed: true, plane: access.plane, role: access.role } : { allowed: false, reason: access.reason },
      community_enabled: isJevCommunityEnabled(),
      tenant_id: caller.tenant_id ?? null,
      ...(caller.identity_gaps?.length ? { identity_gaps: caller.identity_gaps } : {}),
      decisions,
    },
  });
});

router.post('/jev/decisions/:name', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: decide() emits the jev.decision.* OASIS event for every call.
  const caller = await callerOr(req, res);
  if (!caller) return;
  const input = (req.body && typeof req.body === 'object' && 'input' in req.body) ? req.body.input : req.body;
  sendResult(res, await decide(String(req.params.name), input, caller, { source: 'api' }));
});

const classifyBody = z.object({
  query: z.string().trim().min(1).max(1000),
  documents: z
    .array(z.object({ id: z.string().trim().min(1).max(200), title: z.string().trim().max(300).optional(), text: z.string().trim().min(1).max(8000) }))
    .min(1)
    .max(JEV_MAX_BATCH),
  include_irrelevant: z.boolean().optional(),
});

router.post('/jev/documents/classify', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: decideMany() -> decide() emits one jev.decision.* OASIS event per document.
  const parsed = classifyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'invalid_input', detail: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return;
  }
  const caller = await callerOr(req, res);
  if (!caller) return;
  const access = resolveJevAccess(caller);
  if (!access.allowed) {
    res.status(403).json({ ok: false, error: access.reason });
    return;
  }
  // Answer once instead of emitting a fallback per document.
  if (!isJevConfigured()) {
    res.status(503).json({ ok: false, error: 'not_configured' });
    return;
  }
  const { query, documents, include_irrelevant } = parsed.data;
  const started = Date.now();
  const results = await decideMany(
    'document_relevance',
    documents.map((d) => ({ query, title: d.title, text: d.text })),
    caller,
    { source: 'api:documents.classify' },
  );
  const rows = documents.map((d, i) => {
    const r = results[i];
    if (!r.ok) return { id: d.id, outcome: r.outcome, reason: r.reason };
    return {
      id: d.id,
      outcome: r.outcome,
      relevant: r.verdict.value === true,
      probability: r.verdict.probability,
      confidence: r.verdict.confidence,
      strength: r.answers.strength?.value,
      strength_label: r.answers.strength?.label,
    };
  });
  const decided = rows.filter((r: any) => r.outcome === 'decided');
  const relevant = decided
    .filter((r: any) => r.relevant)
    .sort((a: any, b: any) => (b.strength ?? 0) - (a.strength ?? 0) || (b.probability ?? 0) - (a.probability ?? 0));
  const totals = results.reduce(
    (acc, r) => (r.ok ? { tokens: acc.tokens + r.input_tokens, cost: acc.cost + r.cost_usd } : acc),
    { tokens: 0, cost: 0 },
  );
  res.json({
    ok: true,
    data: {
      query,
      counts: {
        documents: documents.length,
        relevant: relevant.length,
        abstained: rows.filter((r: any) => r.outcome === 'abstained').length,
        failed: rows.filter((r: any) => r.outcome !== 'decided' && r.outcome !== 'abstained').length,
      },
      relevant,
      ...(include_irrelevant ? { all: rows } : {}),
      input_tokens: totals.tokens,
      cost_usd: Math.round(totals.cost * 1e8) / 1e8,
      duration_ms: Date.now() - started,
    },
  });
});

router.get('/jev/admin/stats', requireAuth, requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  // VTID-04754: since-boot counters (this task) + persisted month spend per
  // tenant × plane + shadow agreement per gate + the gate kill switches.
  const days = Math.max(1, Math.min(Number(req.query.days) || 14, 90));
  const month = currentMonthUtc();
  const sb = getSupabase();
  let spend: unknown = null;
  let gates: unknown = null;
  // VTID-05012: the loop a silent gate sits on, so "gate broken" and "loop stopped" read differently.
  let devAutopilot: { kill_switch: boolean; updated_at: string | null } | null = null;
  // Gate health needs a window of at least 48 h, whatever window the caller asked for.
  let healthStats: unknown = null;
  const errors: string[] = [];
  if (sb) {
    const [s1, s2, s3] = await Promise.all([fetchMonthSpendRows(sb, month), shadowGateStatsRpc(sb, days), fetchDevAutopilotKillSwitch(sb)]);
    if (s1.error) errors.push(`spend: ${s1.error.message}`);
    else spend = s1.data;
    if (s2.error) errors.push(`shadow: ${s2.error.message}`);
    else gates = s2.data;
    if (s3.error) errors.push(`dev_autopilot_config: ${s3.error.message}`);
    else if (s3.data) devAutopilot = { kill_switch: !!s3.data.kill_switch, updated_at: s3.data.updated_at ?? null };
    if (days >= JEV_HEALTH_MIN_DAYS) healthStats = gates;
    else {
      const s4 = await shadowGateStatsRpc(sb, JEV_HEALTH_MIN_DAYS);
      if (s4.error) errors.push(`shadow_health: ${s4.error.message}`);
      else healthStats = s4.data;
    }
  } else {
    errors.push('no_supabase_client');
  }
  const gate_modes = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => /^JEV_[A-Z0-9_]+_MODE$/.test(k)).map(([k, v]) => [k, v]),
  );
  res.json({
    ok: true,
    data: {
      configured: isJevConfigured(),
      model: jevModel(),
      community_enabled: isJevCommunityEnabled(),
      ...getJevStats(),
      month,
      spend_month: spend,
      shadow_days: days,
      shadow_gates: gates,
      gate_modes,
      gate_health: jevGateHealth(Array.isArray(healthStats) ? (healthStats as Array<{ gate: string; last_row_at?: string | null }>) : null),
      loops: { dev_autopilot: devAutopilot },
      ...(errors.length ? { errors } : {}),
    },
  });
});

export default router;
