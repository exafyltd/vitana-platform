/**
 * VTID-05270 (mt-jobs, lane jobs-tenant-loop): which tenants a scheduled job
 * runs for.
 *
 * One tenant-source rule for every converted entry point (resolveJobTenants):
 *   - an explicit tenant (verified identity, then body `tenant_id`) ⇒ exactly
 *     that tenant, never a fan-out — so a nested call such as AP-0501 →
 *     /scheduled-notifications/morning-briefing runs once for its tenant;
 *   - no tenant + `MT_RESOLUTION_V2=true` ⇒ activeTenantIds();
 *   - no tenant + master off ⇒ [DEFAULT_TENANT_ID] (today).
 *
 * activeTenantIds() = active, non-platform tenants whose
 * `feature_flags.mt.jobs_tenant_loop` is on (mt-flags.ts), UNION
 * DEFAULT_TENANT_ID — the default tenant keeps today's run whatever its own
 * flag says. Evaluated on every call (every tick), never cached at init, so a
 * flag flip takes effect on the next tick without a restart.
 *
 * DB reads live only in job-tenant-loop-repository.ts. A failed read degrades
 * to today's single DEFAULT_TENANT_ID pass, loudly logged.
 */

import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../lib/supabase';
import { resolvePrimaryTenant } from '../tenancy/tenant-context';
import { isJobsTenantLoopEnabled, isMtResolutionV2Enabled, type MtEnv } from '../mt-flags';
import * as repo from './job-tenant-loop-repository';

export const FALLBACK_TENANT_TIMEZONE = 'Europe/Berlin';

export interface JobTenantSettings {
  tenant_id: string;
  timezone?: string | null;
  feature_flags?: unknown;
}

export interface JobTenantContext {
  tenantId: string;
  timezone: string;
  settings: JobTenantSettings | null;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The tenant's `tenant_settings.timezone`; `Europe/Berlin` when the tenant has
 * no settings row (the column itself is NOT NULL) or the stored value is not a
 * valid IANA zone.
 */
export function tenantTimezone(settings: { timezone?: string | null } | null | undefined): string {
  const tz = settings?.timezone;
  if (typeof tz === 'string' && tz.trim() && isValidTimezone(tz.trim())) return tz.trim();
  return FALLBACK_TENANT_TIMEZONE;
}

function log(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event, vtid: 'VTID-05270', ...fields }));
}

/**
 * One context per tenant the loop runs for: DEFAULT_TENANT_ID first (when
 * set), then every active non-platform tenant whose flag is on. One query
 * for the tenant list and one for their settings.
 */
export async function loadActiveTenantContexts(
  sb: SupabaseClient | null = getSupabase(),
  env: MtEnv = process.env,
): Promise<JobTenantContext[]> {
  const defaultTenantId = env.DEFAULT_TENANT_ID || null;
  const fallback = (): JobTenantContext[] =>
    defaultTenantId ? [{ tenantId: defaultTenantId, timezone: FALLBACK_TENANT_TIMEZONE, settings: null }] : [];

  if (!isMtResolutionV2Enabled(env)) return fallback();
  if (!sb) {
    log('job_tenant_loop_degraded', { reason: 'supabase_unavailable' });
    return fallback();
  }

  try {
    const { data: tenantRows, error: tenantErr } = await repo.fetchActiveTenants(sb);
    if (tenantErr || !Array.isArray(tenantRows)) {
      log('job_tenant_loop_degraded', { reason: 'tenants_read_failed', error: tenantErr?.message ?? null });
      return fallback();
    }
    const activeIds = (tenantRows as Array<{ tenant_id: string }>).map((r) => r.tenant_id).filter(Boolean);
    const ids = Array.from(new Set([...(defaultTenantId ? [defaultTenantId] : []), ...activeIds]));
    if (ids.length === 0) return [];

    const { data: settingsRows, error: settingsErr } = await repo.fetchTenantSettings(sb, ids);
    if (settingsErr) {
      log('job_tenant_loop_degraded', { reason: 'tenant_settings_read_failed', error: settingsErr.message ?? null });
      return fallback();
    }
    const byId = new Map<string, JobTenantSettings>();
    for (const row of (settingsRows as JobTenantSettings[] | null) || []) {
      if (row?.tenant_id) byId.set(row.tenant_id, row);
    }

    const contexts: JobTenantContext[] = [];
    for (const tenantId of ids) {
      const settings = byId.get(tenantId) ?? null;
      const isDefault = tenantId === defaultTenantId;
      if (!isDefault && !isJobsTenantLoopEnabled(env, settings)) continue;
      contexts.push({ tenantId, timezone: tenantTimezone(settings), settings });
    }
    return contexts;
  } catch (err: any) {
    log('job_tenant_loop_degraded', { reason: 'exception', error: err?.message || String(err) });
    return fallback();
  }
}

/** The tenant ids the loop runs for (see loadActiveTenantContexts). */
export async function activeTenantIds(
  sb: SupabaseClient | null = getSupabase(),
  env: MtEnv = process.env,
): Promise<string[]> {
  return (await loadActiveTenantContexts(sb, env)).map((c) => c.tenantId);
}

/** Run `fn` once per active tenant, in sequence, with that tenant's context. */
export async function forEachActiveTenant<T>(
  sb: SupabaseClient | null,
  fn: (ctx: JobTenantContext) => Promise<T>,
  env: MtEnv = process.env,
): Promise<Array<{ tenantId: string; result: T }>> {
  const contexts = await loadActiveTenantContexts(sb, env);
  const out: Array<{ tenantId: string; result: T }> = [];
  for (const ctx of contexts) {
    out.push({ tenantId: ctx.tenantId, result: await fn(ctx) });
  }
  return out;
}

/** The explicit tenant of a job request: verified identity, then body. */
export function explicitJobTenant(req: Request): string | null {
  return (req as any).identity?.tenant_id || (req as any).body?.tenant_id || null;
}

/**
 * The tenant-source rule (see the module header). An empty array means no
 * tenant could be named; the caller answers as it does today
 * (`tenant_id required`).
 */
export async function resolveJobTenants(
  req: Request,
  sb: SupabaseClient | null = getSupabase(),
  env: MtEnv = process.env,
): Promise<string[]> {
  const explicit = explicitJobTenant(req);
  if (explicit) return [explicit];
  if (isMtResolutionV2Enabled(env)) return activeTenantIds(sb, env);
  return env.DEFAULT_TENANT_ID ? [env.DEFAULT_TENANT_ID] : [];
}

/**
 * The actor's real tenant for an automation event: a known tenant first, else
 * the user's primary tenant via the existing resolvePrimaryTenant
 * (tenancy/tenant-context.ts). Unresolvable ⇒ null (logged) — never
 * DEFAULT_TENANT_ID.
 */
export async function resolveActorTenant(actor: {
  tenantId?: string | null;
  userId?: string | null;
}): Promise<string | null> {
  if (actor.tenantId) return actor.tenantId;
  if (!actor.userId) {
    log('actor_tenant_unresolved', { reason: 'no_user_id' });
    return null;
  }
  const result = await resolvePrimaryTenant(actor.userId);
  if (result.status === 'found') return result.tenantId;
  log('actor_tenant_unresolved', { reason: result.status, user_id: actor.userId });
  return null;
}

/** The `sub` of a bearer JWT (the same decode the routes already do); null when absent. */
export function jwtSubject(token: string | null | undefined): string | null {
  if (!token) return null;
  try {
    const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).sub;
    return typeof sub === 'string' && sub ? sub : null;
  } catch {
    return null;
  }
}

// ── Heartbeat loop (index.ts) ───────────────────────────────────────────────

/**
 * Registration gate of the heartbeat interval: today's
 * `AUTOPILOT_HEARTBEAT_ENABLED && DEFAULT_TENANT_ID`, also opening on the
 * env master so a deployment without DEFAULT_TENANT_ID can still loop tenants.
 */
export function shouldRegisterHeartbeat(env: MtEnv = process.env): boolean {
  const heartbeatEnabled = env.AUTOPILOT_HEARTBEAT_ENABLED === 'true';
  return heartbeatEnabled && (Boolean(env.DEFAULT_TENANT_ID) || isMtResolutionV2Enabled(env));
}

/**
 * The tenants one heartbeat tick runs for, evaluated INSIDE the tick. Master
 * off ⇒ [DEFAULT_TENANT_ID] (today); on ⇒ activeTenantIds(). Empty ⇒ no-op.
 */
export async function heartbeatTenantsForTick(
  sb: SupabaseClient | null = getSupabase(),
  env: MtEnv = process.env,
): Promise<string[]> {
  if (!isMtResolutionV2Enabled(env)) return env.DEFAULT_TENANT_ID ? [env.DEFAULT_TENANT_ID] : [];
  return activeTenantIds(sb, env);
}

/** One heartbeat tick: runHeartbeatCycle once per tenant, in sequence. */
export async function runHeartbeatTick(
  runCycle: (tenantId: string) => Promise<{ executed: string[]; skipped: string[]; failed: string[] }>,
  sb: SupabaseClient | null = getSupabase(),
  env: MtEnv = process.env,
): Promise<{ tenants: string[]; executed: number; skipped: number; failed: number }> {
  const tenants = await heartbeatTenantsForTick(sb, env);
  const total = { tenants, executed: 0, skipped: 0, failed: 0 };
  for (const tenantId of tenants) {
    const result = await runCycle(tenantId);
    total.executed += result.executed.length;
    total.skipped += result.skipped.length;
    total.failed += result.failed.length;
  }
  return total;
}

// ── Route fan-out ───────────────────────────────────────────────────────────

type JobHandler = (req: Request, res: Response, tenantId: string | null) => unknown;

/** A minimal Response stand-in that records status + JSON body. */
function captureResponse(): { res: Response; result: () => { status: number; body: unknown } } {
  let status = 200;
  let body: unknown = undefined;
  const res: any = {
    status(code: number) {
      status = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
  };
  return { res: res as Response, result: () => ({ status, body }) };
}

/**
 * Wrap a single-tenant job route.
 *
 * - Master off: the handler gets `offTenant(req)` — exactly today's tenant
 *   source for that router — and the live response (byte-for-byte today).
 * - Master on: resolveJobTenants. One tenant ⇒ the handler runs once with the
 *   live response (same shape as today). Two or more ⇒ one pass per tenant in
 *   sequence; the reply is `{ ok, fanout: true, per_tenant: [{ tenant_id,
 *   status, body }] }`, status 200 when every pass answered < 400, else 207.
 */
export function withJobTenants(
  handler: JobHandler,
  offTenant: (req: Request) => string | null,
  opts: { getClient?: () => Promise<SupabaseClient | null> | SupabaseClient | null; env?: () => MtEnv } = {},
) {
  return async (req: Request, res: Response): Promise<unknown> => {
    const env = opts.env ? opts.env() : process.env;
    if (!isMtResolutionV2Enabled(env)) return handler(req, res, offTenant(req));

    const sb = opts.getClient ? await opts.getClient() : getSupabase();
    const tenants = await resolveJobTenants(req, sb, env);
    if (tenants.length <= 1) return handler(req, res, tenants[0] ?? null);

    const perTenant: Array<{ tenant_id: string; status: number; body: unknown }> = [];
    for (const tenantId of tenants) {
      const cap = captureResponse();
      try {
        await handler(req, cap.res, tenantId);
        const { status, body } = cap.result();
        perTenant.push({ tenant_id: tenantId, status, body });
      } catch (err: any) {
        log('job_tenant_pass_failed', { tenant_id: tenantId, path: req.path, error: err?.message || String(err) });
        perTenant.push({ tenant_id: tenantId, status: 500, body: { ok: false, error: err?.message || String(err) } });
      }
    }
    const ok = perTenant.every((p) => p.status < 400);
    return res.status(ok ? 200 : 207).json({ ok, fanout: true, per_tenant: perTenant });
  };
}
