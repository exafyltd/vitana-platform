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
import { fetchCallerActiveRoleForTenant } from '../middleware/require-tenant-admin-repository';
import { decide, decideMany, JEV_MAX_BATCH, JevDecisionResult } from '../services/jev/jev-decision-service';
import { listJevDecisions } from '../services/jev/jev-decisions';
import { resolveJevAccess, roleMayUseDecision, isJevCommunityEnabled, JevCaller } from '../services/jev/jev-access';
import { isJevConfigured, jevModel } from '../services/jev/jev-client';
import { getJevStats } from '../services/jev/jev-telemetry';

const router = Router();

/** Builds the caller from the verified identity; the role is looked up, never taken from the body. */
export async function resolveJevCaller(req: AuthenticatedRequest): Promise<JevCaller> {
  const id = req.identity!;
  const caller: JevCaller = { actor_id: id.user_id, exafy_admin: id.exafy_admin, tenant_id: id.tenant_id };
  if (id.exafy_admin || !id.tenant_id) return caller;
  try {
    const sb = getSupabase();
    if (!sb) return caller;
    const { data } = await fetchCallerActiveRoleForTenant(sb, id.user_id, id.tenant_id);
    caller.active_role = (data as { active_role?: string } | null)?.active_role ?? null;
  } catch (err: any) {
    console.warn('[jev] active_role lookup failed:', err?.message || err);
  }
  return caller;
}

function sendResult(res: Response, r: JevDecisionResult): void {
  if (r.ok) {
    res.json({ ok: true, data: r });
    return;
  }
  res.status(r.status ?? 500).json({ ok: false, error: r.reason, detail: r.detail, data: r });
}

router.get('/jev/decisions', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const caller = await resolveJevCaller(req);
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
      decisions,
    },
  });
});

router.post('/jev/decisions/:name', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: decide() emits the jev.decision.* OASIS event for every call.
  const caller = await resolveJevCaller(req);
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
  const caller = await resolveJevCaller(req);
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

router.get('/jev/admin/stats', requireAuth, requireExafyAdmin, (_req: AuthenticatedRequest, res: Response) => {
  res.json({ ok: true, data: { configured: isJevConfigured(), model: jevModel(), community_enabled: isJevCommunityEnabled(), ...getJevStats() } });
});

export default router;
