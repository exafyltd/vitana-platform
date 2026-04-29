/**
 * Self-Healing Snapshot Service
 * Handles health snapshots, blast radius detection, and rollback
 * for the Vitana autonomous self-healing system.
 */

import { randomUUID } from 'crypto';
import { HealthSnapshot, EndpointState, VerificationResult } from '../types/self-healing';
import { ENDPOINT_FILE_MAP } from '../types/self-healing';
import { emitOasisEvent } from './oasis-event-service';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const GATEWAY_URL = process.env.GATEWAY_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';

function supabaseHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
  };
}

/**
 * VTID-02030f: returns a structured result so callers (especially the
 * diagnostic endpoint) can tell when fetch() resolved-but-the-message-
 * never-arrived (401/403/404 from the webhook). Existing callers ignore
 * the return value, so behavior for them is unchanged.
 */
export async function notifyGChat(
  message: string,
): Promise<{ ok: boolean; webhook_set: boolean; status?: number; body_excerpt?: string; error?: string }> {
  const webhook = process.env.GCHAT_COMMANDHUB_WEBHOOK;
  if (!webhook) {
    console.warn('[Self-Healing] GCHAT_COMMANDHUB_WEBHOOK not set, skipping notification');
    return { ok: false, webhook_set: false, error: 'webhook_not_set' };
  }
  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
    let body = '';
    try { body = (await r.text()).slice(0, 400); } catch { /* ignore */ }
    if (!r.ok) {
      console.error(
        `[Self-Healing] GChat webhook returned non-2xx: status=${r.status} body=${body}`,
      );
    }
    return { ok: r.ok, webhook_set: true, status: r.status, body_excerpt: body };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error('[Self-Healing] GChat notification failed:', msg);
    return { ok: false, webhook_set: true, error: msg };
  }
}

export async function captureHealthSnapshot(
  vtid: string,
  phase: 'pre_fix' | 'post_fix'
): Promise<HealthSnapshot> {
  const endpointPaths = Object.keys(ENDPOINT_FILE_MAP);
  const startTime = Date.now();

  const results = await Promise.allSettled(
    endpointPaths.map(async (path): Promise<EndpointState> => {
      const url = `${GATEWAY_URL}${path}`;
      const t0 = Date.now();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const elapsed = Date.now() - t0;
        return {
          endpoint: path,
          status: res.ok ? 'healthy' : 'down',
          http_status: res.status,
          response_time_ms: elapsed,
        };
      } catch (err: unknown) {
        const elapsed = Date.now() - t0;
        const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
        return {
          endpoint: path,
          status: isTimeout ? 'timeout' : 'down',
          http_status: null,
          response_time_ms: elapsed,
        };
      }
    })
  );

  const endpoints: EndpointState[] = results.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          endpoint: 'unknown',
          status: 'down' as const,
          http_status: null,
          response_time_ms: Date.now() - startTime,
        }
  );

  const healthyCount = endpoints.filter((e) => e.status === 'healthy').length;

  const snapshot: HealthSnapshot = {
    id: randomUUID(),
    vtid,
    phase,
    timestamp: new Date().toISOString(),
    total: endpoints.length,
    healthy: healthyCount,
    endpoints,
    git_sha: null,
    cloud_run_revision: null,
  };

  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/self_healing_snapshots`, {
        method: 'POST',
        headers: {
          ...supabaseHeaders(),
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          id: snapshot.id,
          vtid: snapshot.vtid,
          phase: snapshot.phase,
          timestamp: snapshot.timestamp,
          total: snapshot.total,
          healthy: snapshot.healthy,
          endpoints: snapshot.endpoints,
          git_sha: snapshot.git_sha,
          cloud_run_revision: snapshot.cloud_run_revision,
        }),
      });
    } catch (err) {
      console.error('[Self-Healing] Failed to store snapshot in Supabase:', err);
    }
  }

  await emitOasisEvent({
    vtid,
    type: `self-healing.snapshot.${phase}`,
    source: 'self-healing-snapshot-service',
    status: 'info',
    message: `Health snapshot captured (${phase}): ${healthyCount}/${endpoints.length} healthy`,
    payload: {
      snapshot_id: snapshot.id,
      total: snapshot.total,
      healthy: snapshot.healthy,
      phase,
    },
    actor_role: 'system',
    surface: 'system',
  });

  return snapshot;
}

export async function verifyFixWithBlastRadiusCheck(
  vtid: string
): Promise<VerificationResult> {
  let preFixSnapshot: HealthSnapshot | null = null;

  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/self_healing_snapshots?vtid=eq.${encodeURIComponent(vtid)}&phase=eq.pre_fix&order=timestamp.desc&limit=1`,
        { headers: supabaseHeaders() }
      );
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) {
        preFixSnapshot = rows[0] as HealthSnapshot;
      }
    } catch (err) {
      console.error('[Self-Healing] Failed to fetch pre_fix snapshot:', err);
    }
  }

  if (!preFixSnapshot) {
    console.warn('[Self-Healing] No pre_fix snapshot found, capturing one now');
    preFixSnapshot = await captureHealthSnapshot(vtid, 'pre_fix');
  }

  await new Promise((resolve) => setTimeout(resolve, 30_000));

  const postFixSnapshot = await captureHealthSnapshot(vtid, 'post_fix');

  const preStateMap = new Map<string, EndpointState>();
  for (const ep of preFixSnapshot.endpoints) {
    preStateMap.set(ep.endpoint, ep);
  }

  const newlyBroken: string[] = [];
  const newlyFixed: string[] = [];

  for (const postEp of postFixSnapshot.endpoints) {
    const preEp = preStateMap.get(postEp.endpoint);
    if (!preEp) continue;

    const wasHealthy = preEp.status === 'healthy';
    const isHealthy = postEp.status === 'healthy';

    if (wasHealthy && !isHealthy) {
      newlyBroken.push(postEp.endpoint);
    }
    if (!wasHealthy && isHealthy) {
      newlyFixed.push(postEp.endpoint);
    }
  }

  let targetEndpoint: string | null = null;
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}&select=metadata&limit=1`,
        { headers: supabaseHeaders() }
      );
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0 && rows[0].metadata) {
        targetEndpoint = rows[0].metadata.endpoint || rows[0].metadata.target_endpoint || null;
      }
    } catch (err) {
      console.error('[Self-Healing] Failed to fetch target endpoint from vtid_ledger:', err);
    }
  }

  const targetFixed = targetEndpoint
    ? newlyFixed.includes(targetEndpoint)
    : newlyFixed.length > 0;

  const netHealthDelta = postFixSnapshot.healthy - preFixSnapshot.healthy;

  let action: VerificationResult['action'];
  let blastRadius: VerificationResult['blast_radius'];

  if (newlyBroken.length === 0 && targetFixed) {
    action = 'keep';
    blastRadius = 'none';

    await emitOasisEvent({
      vtid,
      type: 'self-healing.verification.success',
      source: 'self-healing-snapshot-service',
      status: 'success',
      message: `Fix verified successfully. Target endpoint fixed, no blast radius. Net delta: +${netHealthDelta}`,
      payload: {
        newly_fixed: newlyFixed,
        net_health_delta: netHealthDelta,
        target_endpoint: targetEndpoint,
      },
      actor_role: 'system',
      surface: 'system',
    });

    await notifyGChat(
      `✅ *Self-Healing SUCCESS*\n` +
      `VTID: \`${vtid}\`\n` +
      `Target: \`${targetEndpoint}\` is now *healthy*\n` +
      `Health: ${preFixSnapshot.healthy}/${preFixSnapshot.total} → ${postFixSnapshot.healthy}/${postFixSnapshot.total} (+${netHealthDelta})\n` +
      `Blast radius: none — no other endpoints affected\n` +
      `Fix is *live in production*`
    );
  } else if (newlyBroken.length > 0) {
    action = 'rollback';
    blastRadius = newlyBroken.length >= 3 ? 'critical' : 'contained';

    await emitOasisEvent({
      vtid,
      type: 'self-healing.blast_radius.detected',
      source: 'self-healing-snapshot-service',
      status: 'error',
      message: `Blast radius detected: ${newlyBroken.length} endpoints broken after fix. Initiating rollback.`,
      payload: {
        newly_broken: newlyBroken,
        newly_fixed: newlyFixed,
        net_health_delta: netHealthDelta,
        blast_radius: blastRadius,
      },
      actor_role: 'system',
      surface: 'system',
    });

    await executeRollback(vtid, preFixSnapshot);

    await notifyGChat(
      `🚨 *Self-Healing Blast Radius Detected*\n` +
      `VTID: \`${vtid}\`\n` +
      `Newly broken endpoints (${newlyBroken.length}): ${newlyBroken.join(', ')}\n` +
      `Blast radius: *${blastRadius}*\n` +
      `Action: *ROLLBACK INITIATED*`
    );
  } else {
    action = 'escalate';
    blastRadius = 'none';

    await emitOasisEvent({
      vtid,
      type: 'self-healing.verification.escalate',
      source: 'self-healing-snapshot-service',
      status: 'warning',
      message: `Target endpoint not fixed but no blast radius. Escalating for manual review.`,
      payload: {
        target_endpoint: targetEndpoint,
        newly_fixed: newlyFixed,
        net_health_delta: netHealthDelta,
      },
      actor_role: 'system',
      surface: 'system',
    });

    await notifyGChat(
      `⚠️ *Self-Healing Escalation*\n` +
      `VTID: \`${vtid}\`\n` +
      `Target endpoint \`${targetEndpoint || 'unknown'}\` not fixed after auto-heal attempt.\n` +
      `No blast radius detected. Net health delta: ${netHealthDelta}\n` +
      `Action: *ESCALATE — manual review required*`
    );
  }

  const result: VerificationResult = {
    vtid,
    target_endpoint_fixed: targetFixed,
    blast_radius: blastRadius,
    newly_broken: newlyBroken,
    newly_fixed: newlyFixed,
    net_health_delta: netHealthDelta,
    action,
    pre_fix_snapshot_id: preFixSnapshot.id,
    post_fix_snapshot_id: postFixSnapshot.id,
  };

  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/self_healing_log?vtid=eq.${encodeURIComponent(vtid)}&order=created_at.desc&limit=1`,
        {
          method: 'PATCH',
          headers: {
            ...supabaseHeaders(),
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            outcome: action === 'keep' ? 'fixed' : action === 'rollback' ? 'rolled_back' : 'escalated',
            blast_radius: blastRadius,
            newly_broken: newlyBroken,
            net_health_delta: netHealthDelta,
            resolved_at: action === 'keep' ? new Date().toISOString() : null,
          }),
        }
      );
    } catch (err) {
      console.error('[Self-Healing] Failed to update self_healing_log:', err);
    }
  }

  return result;
}

export async function executeRollback(
  vtid: string,
  preFixSnapshot: HealthSnapshot
): Promise<void> {
  await emitOasisEvent({
    vtid,
    type: 'self-healing.rollback.started',
    source: 'self-healing-snapshot-service',
    status: 'warning',
    message: `Rollback initiated for VTID ${vtid}`,
    payload: {
      pre_fix_snapshot_id: preFixSnapshot.id,
      pre_fix_healthy: preFixSnapshot.healthy,
      pre_fix_total: preFixSnapshot.total,
    },
    actor_role: 'system',
    surface: 'system',
  });

  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
    try {
      // Update existing self_healing_log entry (created during injection) to record rollback
      await fetch(
        `${SUPABASE_URL}/rest/v1/self_healing_log?vtid=eq.${encodeURIComponent(vtid)}&order=created_at.desc&limit=1`,
        {
          method: 'PATCH',
          headers: {
            ...supabaseHeaders(),
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            outcome: 'rolled_back',
            blast_radius: 'critical',
            resolved_at: new Date().toISOString(),
            diagnosis: {
              rollback_reason: 'Blast radius detected during post-fix verification',
              pre_fix_snapshot_id: preFixSnapshot.id,
              target_revision: preFixSnapshot.cloud_run_revision,
            },
          }),
        },
      );
    } catch (err) {
      console.error('[Self-Healing] Failed to record rollback in self_healing_log:', err);
    }
  }

  await emitOasisEvent({
    vtid,
    type: 'self-healing.rollback.requested',
    source: 'self-healing-snapshot-service',
    status: 'error',
    message: `Rollback requested for VTID ${vtid}. Target revision: ${preFixSnapshot.cloud_run_revision || 'unknown'}. Awaiting EXEC-DEPLOY or manual intervention.`,
    payload: {
      target_revision: preFixSnapshot.cloud_run_revision,
      pre_fix_snapshot_id: preFixSnapshot.id,
      pre_fix_healthy: preFixSnapshot.healthy,
    },
    actor_role: 'system',
    surface: 'system',
  });

  await notifyGChat(
    `🔄 *Rollback Requested*\n` +
    `VTID: \`${vtid}\`\n` +
    `Target revision: \`${preFixSnapshot.cloud_run_revision || 'unknown'}\`\n` +
    `Pre-fix health: ${preFixSnapshot.healthy}/${preFixSnapshot.total}\n` +
    `⚡ *Requires EXEC-DEPLOY workflow or manual Cloud Run traffic shift*`
  );

  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}`,
        {
          method: 'PATCH',
          headers: {
            ...supabaseHeaders(),
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            status: 'failed',
            metadata: {
              rolled_back_at: new Date().toISOString(),
              reason: 'Blast radius detected — rollback requested',
              pre_fix_snapshot_id: preFixSnapshot.id,
              target_revision: preFixSnapshot.cloud_run_revision,
            },
          }),
        }
      );
    } catch (err) {
      console.error('[Self-Healing] Failed to update vtid_ledger for rollback:', err);
    }
  }

  await emitOasisEvent({
    vtid,
    type: 'self-healing.rollback.completed',
    source: 'self-healing-snapshot-service',
    status: 'info',
    message: `Rollback request recorded for VTID ${vtid}. Actual revision shift is async via EXEC-DEPLOY.`,
    payload: {
      pre_fix_snapshot_id: preFixSnapshot.id,
      target_revision: preFixSnapshot.cloud_run_revision,
    },
    actor_role: 'system',
    surface: 'system',
  });
}
