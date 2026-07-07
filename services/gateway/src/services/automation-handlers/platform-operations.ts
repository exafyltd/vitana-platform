/**
 * Platform Operations Handlers — AP-1000 series (AP-1003/1004/1005)
 *
 * VTID: VTID-01250
 * AP-1001/AP-1002 are stub handlers living in engagement-events.ts
 * (runVtidLifecycle/runGovernanceFlagCheck) — these three are the
 * PLANNED gaps in this domain.
 *
 * Unlike the other domains, these are about the PLATFORM ITSELF (deploys,
 * error rates, migrations), not user-facing features. There is no GCP
 * Cloud Logging/Monitoring client in this service (see package.json) and no
 * dedicated error-tracking table, so these lean on the two real signals
 * that exist live: oasis_events (deploy outcomes + status='error' rows) and
 * a query-and-see-if-it-errors check against expected tables (mirroring the
 * exact method used this session to discover several silently-never-applied
 * migrations).
 */

import { AutomationContext } from '../../types/automations';
import { registerHandler } from '../automation-executor';

// ── AP-1003: Post-Deploy Health Check ───────────────────────
// CI writes deploy.<service>.success/failed directly into oasis_events
// (service='ci_cd'), bypassing dispatchEvent — nothing in the gateway
// currently calls dispatchEvent for these topics (see registry comment).
const POST_DEPLOY_LOOKBACK_MIN = 15;

async function runPostDeployHealthCheck(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const service = payload?.service || 'gateway';
  const { supabase } = ctx;

  const since = new Date(Date.now() - POST_DEPLOY_LOOKBACK_MIN * 60 * 1000).toISOString();

  const { data: deployEvents } = await supabase
    .from('oasis_events')
    .select('topic, service, status, message, created_at')
    .like('topic', 'deploy.%')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(50);

  const failed = (deployEvents || []).filter((e: any) => e.topic.endsWith('.failed'));
  if (failed.length === 0) {
    ctx.log(`No deploy failures in the last ${POST_DEPLOY_LOOKBACK_MIN}m for ${service}.`);
    return { usersAffected: 0, actionsTaken: 0 };
  }

  // Best-available liveness signal — /alive has no dependency checks, so
  // this only confirms the process is responding, not that it's "healthy".
  let aliveOk = true;
  try {
    const gatewayUrl = process.env.GATEWAY_INTERNAL_URL || `http://localhost:${process.env.PORT || 8080}`;
    const resp = await fetch(`${gatewayUrl}/alive`);
    aliveOk = resp.ok;
  } catch {
    aliveOk = false;
  }

  const summary = failed.map((e: any) => `${e.topic} @ ${e.created_at}`).slice(0, 5).join('; ');

  const opsUsers = await ctx.queryTargetUsers();
  let usersAffected = 0;
  let actionsTaken = 0;
  for (const { user_id } of opsUsers) {
    ctx.notify(user_id, 'admin_digest', {
      title: aliveOk ? 'Deploy failure detected' : 'Deploy failure + /alive unreachable',
      body: `${failed.length} deploy failure event(s) in the last ${POST_DEPLOY_LOOKBACK_MIN}m: ${summary}`,
      data: { service, alive_ok: String(aliveOk), failure_count: String(failed.length) },
    });
    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.post_deploy_health.reported', {
    service, failure_count: failed.length, alive_ok: aliveOk,
  });

  return { usersAffected, actionsTaken };
}

// ── AP-1004: Service Error Rate Alert ───────────────────────
// No dedicated error-tracking table exists; oasis_events.status='error' is
// the only live error signal, so this is necessarily thin — it reflects
// whatever services already log as status='error' to OASIS.
const ERROR_RATE_WINDOW_MIN = 30;
const ERROR_RATE_THRESHOLD = 5; // per service, per window
const ERROR_RATE_COOLDOWN_MIN = 60; // don't re-alert same service more than hourly

async function runServiceErrorRateAlert(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const windowStart = new Date(Date.now() - ERROR_RATE_WINDOW_MIN * 60 * 1000).toISOString();
  const cooldownCutoff = new Date(Date.now() - ERROR_RATE_COOLDOWN_MIN * 60 * 1000).toISOString();

  const { data: errorEvents } = await supabase
    .from('oasis_events')
    .select('service, message, created_at')
    .eq('status', 'error')
    .gte('created_at', windowStart)
    .limit(1000);

  const byService = new Map<string, { count: number; sample: string }>();
  for (const e of errorEvents || []) {
    const svc = e.service || 'unknown';
    const entry = byService.get(svc) || { count: 0, sample: e.message || '' };
    entry.count++;
    byService.set(svc, entry);
  }

  const breaches = [...byService.entries()].filter(([, v]) => v.count >= ERROR_RATE_THRESHOLD);
  if (breaches.length === 0) {
    ctx.log(`No service over ${ERROR_RATE_THRESHOLD} errors in ${ERROR_RATE_WINDOW_MIN}m.`);
    return { usersAffected: 0, actionsTaken: 0 };
  }

  const opsUsers = await ctx.queryTargetUsers();
  for (const [service, info] of breaches) {
    // Per-service cooldown via automation_runs.metadata so ops isn't re-paged every cycle.
    const { data: recentAlert } = await supabase
      .from('automation_runs')
      .select('id')
      .eq('automation_id', 'AP-1004')
      .gte('completed_at', cooldownCutoff)
      .contains('metadata', { alerted_service: service })
      .limit(1);
    if (recentAlert && recentAlert.length > 0) continue;

    for (const { user_id } of opsUsers) {
      ctx.notify(user_id, 'admin_digest', {
        title: `Elevated error rate: ${service}`,
        body: `${info.count} error-status OASIS events in the last ${ERROR_RATE_WINDOW_MIN}m. Sample: ${info.sample.slice(0, 140)}`,
        data: { service, error_count: String(info.count), alerted_service: service },
      });
      usersAffected++;
      actionsTaken++;
    }
  }

  await ctx.emitEvent('autopilot.error_rate.reported', {
    services_over_threshold: breaches.map(([s]) => s),
    threshold: ERROR_RATE_THRESHOLD,
    window_minutes: ERROR_RATE_WINDOW_MIN,
  });

  return { usersAffected, actionsTaken };
}

// ── AP-1005: Database Migration Verification ────────────────
// This session discovered several migrations that silently never applied
// due to timestamp collisions (schema_migrations.version can drift from a
// migration file's own name/timestamp). There's no reliable way for a
// gateway-runtime Supabase client (PostgREST-based, public-schema only) to
// introspect supabase_migrations/information_schema directly, so this
// verifies the ONLY thing it safely can: whether the tables a migration was
// supposed to create actually exist, by querying them and checking for a
// "relation does not exist" style error — the same method used to find
// contextual_opportunities/automation_runs missing earlier this session.
// Payload-driven: the caller (a migration-apply workflow) must say what it
// expects via { expected_name, expected_tables: string[] }.
async function runDatabaseMigrationVerification(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const expectedName: string | undefined = payload?.expected_name;
  const expectedTables: string[] = payload?.expected_tables || [];
  if (!expectedName || expectedTables.length === 0) {
    ctx.log('AP-1005: no expected_name/expected_tables in event payload — nothing to verify.');
    return { usersAffected: 0, actionsTaken: 0 };
  }

  const { supabase } = ctx;
  const missingTables: string[] = [];
  for (const table of expectedTables) {
    const { error } = await supabase.from(table).select('*', { head: true, count: 'exact' }).limit(1);
    if (error) missingTables.push(table);
  }

  if (missingTables.length === 0) {
    ctx.log(`AP-1005: migration "${expectedName}" verified — all ${expectedTables.length} expected table(s) exist.`);
    await ctx.emitEvent('autopilot.migration_verification.passed', {
      expected_name: expectedName,
      tables_checked: expectedTables.length,
    });
    return { usersAffected: 0, actionsTaken: 0 };
  }

  const opsUsers = await ctx.queryTargetUsers();
  let usersAffected = 0;
  let actionsTaken = 0;
  for (const { user_id } of opsUsers) {
    ctx.notify(user_id, 'admin_digest', {
      title: 'Migration verification failed',
      body: `Migration "${expectedName}" — expected table(s) missing or unreachable: ${missingTables.join(', ')}. It may have silently failed to apply.`,
      data: { expected_name: expectedName, missing_tables: missingTables.join(',') },
    });
    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.migration_verification.failed', {
    expected_name: expectedName,
    missing_tables: missingTables,
  });

  return { usersAffected, actionsTaken };
}

export function registerPlatformOperationsHandlers(): void {
  registerHandler('runPostDeployHealthCheck', runPostDeployHealthCheck);
  registerHandler('runServiceErrorRateAlert', runServiceErrorRateAlert);
  registerHandler('runDatabaseMigrationVerification', runDatabaseMigrationVerification);
}
