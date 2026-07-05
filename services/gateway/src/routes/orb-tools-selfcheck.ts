/**
 * ORB tool self-check harness.
 *
 * Answers "are we testing what we build?" for the EXECUTION layer: it invokes
 * the real ORB action tools against a real user's data — no voice session
 * needed — and reports per-tool pass/fail + the exact error. The conversation
 * flow can route perfectly, but if the underlying tool fails the user still
 * hears "I couldn't do that". This surfaces those failures deterministically.
 *
 *   POST /api/v1/admin/orb-tools/selfcheck   body: { user_id, tools?: string[] }
 *
 * Each tool is run via the SAME shared dispatcher the voice path uses
 * (dispatchOrbTool), so a pass here means a pass in production. Results are
 * returned AND emitted to oasis_events (topic 'orb.tools.selfcheck') so they
 * are queryable. Read tools run live; the one write tool exercised
 * (create_index_improvement_plan) cleans up the calendar events it creates.
 *
 * Admin-gated. Safe-by-construction: only no/optional-arg tools + the index
 * plan (with cleanup) are run; tools needing dictated args (send_chat_message,
 * respond_to_match, …) are reported as 'skipped: needs_args', not failures.
 */

import { Router, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { requireAuth, requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

const router = Router();

interface ToolCheck {
  tool: string;
  args: Record<string, unknown>;
  /** Cleanup tag — tools that write get their rows removed after the check. */
  cleanup?: 'index_plan';
}

// Default curated set: the capability tools behind the conversation-flow
// suggestions. Read-safe tools run live; create_index_improvement_plan writes
// calendar events and is cleaned up. Tools that require user-dictated content
// (send_chat_message, share_intent_post, respond_to_match) are intentionally
// NOT auto-run — they'd need real args — and are reported separately.
const DEFAULT_CHECKS: ToolCheck[] = [
  { tool: 'get_vitana_index', args: {} },
  { tool: 'get_pillar_subscores', args: {} },
  { tool: 'get_life_compass', args: {} },
  { tool: 'view_intent_matches', args: {} },
  { tool: 'scan_existing_matches', args: {} },
  { tool: 'get_schedule', args: {} },
  // confirm:true so the harness exercises the actual calendar WRITE path (the
  // tool now previews by default and only writes on confirm); cleaned up below.
  { tool: 'create_index_improvement_plan', args: { days: 7, actions_per_week: 1, confirm: true }, cleanup: 'index_plan' },
];

const NEEDS_ARGS = ['send_chat_message', 'share_intent_post', 'respond_to_match', 'save_diary_entry', 'create_community_post'];

// requireAuth populates req.identity from the JWT; requireExafyAdmin then gates
// on the exafy_admin claim. requireExafyAdmin ALONE is not auth — it 401s when
// identity is unset — so both are required, in this order.
router.post('/selfcheck', requireAuth, requireExafyAdmin, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis: this is a read-mostly diagnostic; it already records
  // each tool result directly to oasis_events (topic 'orb.tools.selfcheck'). The
  // only write is the idempotent cleanup of calendar events the check itself
  // created — not a user state transition worth a separate emit.
  const body = (req.body ?? {}) as { user_id?: string; tools?: string[] };
  const userId = String(body.user_id ?? '').trim();
  if (!userId) return res.status(400).json({ ok: false, error: 'user_id is required' });

  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'supabase_not_configured' });

  // Resolve identity for the target user (tenant + role) the way a tool handler expects.
  let tenantId: string | null = null;
  let role: string | null = null;
  let vitanaId: string | null = null;
  try {
    // NOTE: app_users has no `role` column — selecting it 400s and nulls the
    // whole row. Role is carried on the session/JWT, not this table; for the
    // harness 'community' is a safe stand-in (the tools that gate on role_context
    // now map any role to a valid value), and tenant_id/vitana_id come from here.
    const { data } = await sb
      .from('app_users')
      .select('tenant_id, vitana_id')
      .eq('user_id', userId)
      .maybeSingle();
    const row = data as { tenant_id?: string; vitana_id?: string } | null;
    tenantId = row?.tenant_id ?? null;
    role = 'community';
    vitanaId = row?.vitana_id ?? null;
  } catch { /* identity backfill is best-effort */ }

  const identity = {
    user_id: userId,
    tenant_id: tenantId,
    role,
    vitana_id: vitanaId,
    session_id: `selfcheck:${userId}`,
  };

  const checks = Array.isArray(body.tools) && body.tools.length > 0
    ? DEFAULT_CHECKS.filter((c) => body.tools!.includes(c.tool))
    : DEFAULT_CHECKS;

  const { dispatchOrbTool } = await import('../services/orb-tools-shared');

  const results: Array<{ tool: string; ok: boolean; soft_fail: boolean; ms: number; detail: string }> = [];

  for (const check of checks) {
    const t0 = Date.now();
    let ok = false;
    let soft = false;
    let detail = '';
    try {
      const r = await dispatchOrbTool(check.tool, check.args, identity as any, sb);
      // OrbToolResult: { ok, result?, error?, text? }
      const rr = r as { ok?: boolean; error?: string; result?: unknown; text?: string };
      ok = rr.ok !== false;
      const resultStr = JSON.stringify(rr.result ?? '') + (rr.text ?? '');
      // Soft failure: handler returned ok:true but the payload says it couldn't act.
      soft = ok && /"ok"\s*:\s*false|"reason"\s*:\s*"(no_index_data|no_actions|needs_clarification)"/.test(resultStr);
      detail = (rr.error ?? rr.text ?? resultStr).slice(0, 400);
    } catch (e) {
      ok = false;
      detail = (e instanceof Error ? e.message : String(e)).slice(0, 400);
    }
    const ms = Date.now() - t0;
    results.push({ tool: check.tool, ok: ok && !soft, soft_fail: soft, ms, detail });

    // Cleanup write side-effects so the harness is idempotent.
    if (check.cleanup === 'index_plan') {
      try {
        await sb
          .from('calendar_events')
          .delete()
          .eq('user_id', userId)
          .eq('metadata->>plan', 'index_improvement')
          .gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString());
      } catch { /* best-effort cleanup */ }
    }

    // Emit to oasis_events so the report is queryable via SQL/MCP.
    try {
      await sb.from('oasis_events').insert({
        topic: 'orb.tools.selfcheck',
        source: 'gateway',
        status: ok && !soft ? 'success' : 'error',
        message: `selfcheck ${check.tool}: ${ok && !soft ? 'ok' : soft ? 'soft_fail' : 'fail'}`,
        metadata: { tool: check.tool, user_id: userId, ok: ok && !soft, soft_fail: soft, ms, detail },
      });
    } catch { /* best-effort */ }
  }

  const passed = results.filter((r) => r.ok).length;
  return res.json({
    ok: true,
    user_id: userId,
    summary: { total: results.length, passed, failed: results.length - passed },
    results,
    not_auto_run: NEEDS_ARGS.map((tool) => ({ tool, reason: 'needs user-dictated args' })),
  });
  // impact-allow-no-oasis: diagnostic endpoint — already records each tool result
  // to oasis_events (topic 'orb.tools.selfcheck') above; the only write is the
  // idempotent cleanup of calendar events it itself created. (Placed here, after
  // the inner arrow callbacks, so the scanner's handler-body extraction sees it.)
});

export default router;
