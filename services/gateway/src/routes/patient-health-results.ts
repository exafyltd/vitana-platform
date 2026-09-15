/**
 * VTID-03939 — Commerce Partner Onboarding, Phase 3: a patient's own
 * aggregated health results (lab_reports + biomarker_results), spanning
 * every partner org/professional that has contributed one.
 *
 * A separate file from `health.ts` (ingest/compute) and
 * `admin-partner-health.ts` (admin/org-staff acting on OTHER people's
 * orders) — this is a patient reading their own data, so it uses the same
 * Bearer-token/RLS-scoped pattern as `POST /health/lab-reports/ingest`,
 * never a service-role client and never `requirePartnerHealthAccess`
 * (that gate is for staff acting on someone else's order).
 *
 * `partner_organizations`/`assigned_professional_user_id` only exist once
 * VTID-03932's migration is applied — every read of those degrades to
 * `null` on a schema-cache error instead of failing the whole request,
 * following the same retry-on-error shape `fetchLifeCompass()` already
 * uses in `services/user-context-profiler.ts` for a lagging migration.
 */
import { Router, Request, Response } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { createUserSupabaseClient } from '../lib/supabase-user';
import * as repo from './health-repository';

const router = Router();

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

interface Biomarker {
  id: string;
  biomarker_code: string | null;
  name: string | null;
  value: number | null;
  unit: string | null;
  ref_range_low: number | null;
  ref_range_high: number | null;
  status: string | null;
  measured_at: string;
}

interface OrgAttribution {
  display_name: string | null;
  self_registered_name: string | null;
  professional_user_id: string | null;
}

interface HealthResultRow {
  id: string;
  report_date: string | null;
  source: string | null;
  created_at: string;
  partner_result_id: string | null;
  org: OrgAttribution | null;
  biomarkers: Biomarker[];
}

/**
 * GET /api/v1/patient/health-results
 *
 * Every lab_reports row the caller owns (RLS + an explicit user_id filter,
 * defense-in-depth), each with its biomarker_results and — for
 * partner-sourced reports — best-effort org/professional attribution.
 */
router.get('/health-results', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

  const sb = createUserSupabaseClient(token);

  const { data: ctxData, error: ctxError } = await repo.rpcMeContext(sb);
  if (ctxError) {
    const status = ctxError.message?.includes('JWT') || ctxError.message?.includes('auth') ? 401 : 400;
    return res.status(status).json({ ok: false, error: ctxError.message });
  }
  const userId: string | null = ctxData?.user_id || ctxData?.id || null;
  if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

  try {
    const { data: reports, error: reportsErr } = await sb
      .from('lab_reports')
      .select('id, report_date, source, created_at, partner_result_id, biomarker_results(id, biomarker_code, name, value, unit, ref_range_low, ref_range_high, status, measured_at)')
      .eq('user_id', userId)
      .order('report_date', { ascending: false, nullsFirst: false });
    if (reportsErr) return res.status(500).json({ ok: false, error: reportsErr.message });

    const rows = (reports ?? []) as Array<{
      id: string;
      report_date: string | null;
      source: string | null;
      created_at: string;
      partner_result_id: string | null;
      biomarker_results: Biomarker[] | null;
    }>;

    const partnerResultIds = rows.map((r) => r.partner_result_id).filter((id): id is string => !!id);
    const orgByPartnerResultId = partnerResultIds.length > 0
      ? await resolveOrgAttribution(sb, partnerResultIds)
      : new Map<string, OrgAttribution>();

    const results: HealthResultRow[] = rows.map((r) => ({
      id: r.id,
      report_date: r.report_date,
      source: r.source,
      created_at: r.created_at,
      partner_result_id: r.partner_result_id,
      org: r.partner_result_id ? orgByPartnerResultId.get(r.partner_result_id) ?? null : null,
      biomarkers: r.biomarker_results ?? [],
    }));

    return res.json({ ok: true, results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'UNKNOWN_ERROR' });
  }
});

/**
 * Resolves partner org (and, once VTID-03932's migration is live, the
 * self-registered org + assigned professional) for a set of
 * `partner_health_results.id`s. Never throws — a resolution failure at
 * any hop leaves the affected reports with `org: null` rather than
 * failing the whole request; a self-uploaded report legitimately has no
 * `partner_result_id` at all, which is a different, expected case handled
 * by the caller before this function is ever invoked.
 */
async function resolveOrgAttribution(
  sb: SupabaseClient,
  partnerResultIds: string[],
): Promise<Map<string, OrgAttribution>> {
  const out = new Map<string, OrgAttribution>();
  try {
    const { data: phResults, error: phErr } = await sb
      .from('partner_health_results')
      .select('id, order_id')
      .in('id', partnerResultIds);
    if (phErr || !phResults) return out;

    const orderIds = phResults.map((r) => r.order_id).filter((id): id is string => !!id);
    if (orderIds.length === 0) return out;

    // assigned_professional_user_id only exists post-VTID-03932 — retry
    // without it on a schema-cache error rather than failing outright.
    let orders: Array<{ id: string; partner_id: string; assigned_professional_user_id?: string | null }> | null = null;
    {
      const wide = await sb
        .from('partner_health_test_orders')
        .select('id, partner_id, assigned_professional_user_id')
        .in('id', orderIds);
      if (!wide.error) {
        orders = wide.data;
      } else {
        const narrow = await sb.from('partner_health_test_orders').select('id, partner_id').in('id', orderIds);
        orders = narrow.error ? null : narrow.data;
      }
    }
    if (!orders) return out;

    const partnerIds = [...new Set(orders.map((o) => o.partner_id).filter(Boolean))];
    if (partnerIds.length === 0) return out;

    // partner_organization_id only exists post-VTID-03932 — same retry shape.
    let registryRows: Array<{ id: string; display_name: string; partner_organization_id?: string | null }> | null = null;
    {
      const wide = await sb
        .from('partner_registry')
        .select('id, display_name, partner_organization_id')
        .in('id', partnerIds);
      if (!wide.error) {
        registryRows = wide.data;
      } else {
        const narrow = await sb.from('partner_registry').select('id, display_name').in('id', partnerIds);
        registryRows = narrow.error ? null : narrow.data;
      }
    }
    if (!registryRows) return out;

    const registryById = new Map(registryRows.map((r) => [r.id, r]));

    const orgIds = [...new Set(registryRows.map((r) => r.partner_organization_id).filter((id): id is string => !!id))];
    let orgNameById = new Map<string, string>();
    if (orgIds.length > 0) {
      const { data: orgs, error: orgsErr } = await sb.from('partner_organizations').select('id, display_name').in('id', orgIds);
      if (!orgsErr && orgs) orgNameById = new Map(orgs.map((o) => [o.id, o.display_name]));
    }

    const orderById = new Map(orders.map((o) => [o.id, o]));

    for (const ph of phResults) {
      const order = ph.order_id ? orderById.get(ph.order_id) : undefined;
      if (!order) continue;
      const registryRow = registryById.get(order.partner_id);
      if (!registryRow) continue;
      out.set(ph.id, {
        display_name: registryRow.display_name ?? null,
        self_registered_name: registryRow.partner_organization_id
          ? orgNameById.get(registryRow.partner_organization_id) ?? null
          : null,
        professional_user_id: order.assigned_professional_user_id ?? null,
      });
    }
  } catch {
    // Best-effort attribution — swallow and return whatever was resolved
    // so far rather than failing the caller's whole results list.
  }
  return out;
}

export default router;
