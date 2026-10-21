/**
 * VTID-05174 (Health Hub Phase 0 / D5 remainder, PLAT-D5R) — the health
 * residue an account deletion must reach before erase_user_data() runs,
 * mounted at /api/v1/internal/health-erasure.
 *
 *   POST /member-residue   GATEWAY_SERVICE_TOKEN or exafy_admin JWT; { user_id }
 *
 * Caller: vitana-v1 `request-account-deletion` (Step 0b, V1-D5R), BEFORE any
 * table is erased — part b needs the member's provider ids from
 * user_connections, which erase_user_data() deletes.
 *
 *   a. Vendor revoke (best effort, never blocking): read every
 *      user_connections row, wipe the stored tokens (same update as
 *      disconnect), then revokeAtVendor() per connector — 5 s each, 20 s in
 *      total. Never affects `complete`.
 *   b. connector_webhooks_log: delete rows naming the member by our id
 *      (user_id, Terra reference_id, Vital client_user_id) or by the
 *      member's Terra/Vital provider ids read in part a, then re-select the
 *      same filters for `residual`.
 *      Scale note (sparring R1-F2): the payload paths are unindexed, so each
 *      filter is a sequential scan. Acceptable only while the table stays
 *      small, i.e. while the 90-day purge (CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED)
 *      runs in production; otherwise an expression index follows first.
 *   c. partner_health_result_inbox: delete confirmed rows of the member (they
 *      hold the member's result), clear pending/declined proposals, remove
 *      the id from candidate_user_ids / member_declined_user_ids by a plain
 *      read-then-write (no CAS — single serialized caller; the residual
 *      re-select reports a concurrent re-add as complete:false), re-select.
 *
 * Staging shares the production database: there it answers
 * 409 STAGING_READ_ONLY before any database call. Errors are codes, never
 * database messages. OASIS payloads carry connector ids, statuses and counts
 * only — never tokens, raw_payload or the member id.
 */

import { Router, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireServiceOrAdmin } from '../middleware/require-service-or-admin';
import { getSupabase } from '../lib/supabase';
import { getConnector } from '../connectors';
import { emitOasisEvent } from '../services/oasis-event-service';
import { revokeAtVendor, VENDOR_REVOKE_TIMEOUT_MS } from './wearables';
import * as repo from './health-erasure-internal-repository';

export const HEALTH_ERASURE_VTID = 'VTID-05174';
export const VENDOR_REVOKE_TOTAL_CAP_MS = 20_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isStagingEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITANA_ENV === 'staging';
}

interface ConnectionRow {
  id: string;
  connector_id: string;
  access_token: string | null;
  refresh_token: string | null;
  provider_user_id: string | null;
  provider_username: string | null;
}

export interface VendorRevokeEntry {
  connector_id: string;
  status: string;
}

export interface WebhookLogReport {
  deleted: number;
  residual: number | null;
  error?: string;
}

export interface PartnerInboxReport {
  deleted: number;
  scrubbed: number;
  residual: number | null;
  error?: string;
}

// ---------------------------------------------------------------- part a

async function runVendorRevoke(
  sb: SupabaseClient,
  rows: ConnectionRow[],
  userId: string,
  totalCapMs: number,
): Promise<{ entries: VendorRevokeEntry[]; tokens_wiped: boolean }> {
  if (rows.length === 0) return { entries: [], tokens_wiped: true };

  // Wipe first (as POST /disconnect does): the rows were already read, so the
  // vendor call still has what it needs, and local tokens are gone even if a
  // vendor hangs or the later erase step fails.
  let tokensWiped = true;
  try {
    const { error } = await repo.wipeMemberConnectionTokens(sb, userId);
    if (error) tokensWiped = false;
  } catch {
    tokensWiped = false;
  }

  const byConnector = new Map<string, ConnectionRow[]>();
  for (const r of rows) {
    const list = byConnector.get(r.connector_id) ?? [];
    list.push(r);
    byConnector.set(r.connector_id, list);
  }

  const deadline = Date.now() + totalCapMs;
  const entries: VendorRevokeEntry[] = [];
  for (const [connectorId, list] of byConnector) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      entries.push({ connector_id: connectorId, status: 'skipped_timeout' });
      continue;
    }
    try {
      const r = await revokeAtVendor(getConnector(connectorId), list, Math.min(VENDOR_REVOKE_TIMEOUT_MS, remaining));
      entries.push({ connector_id: connectorId, status: r.status });
    } catch {
      entries.push({ connector_id: connectorId, status: 'failed' });
    }
  }
  return { entries, tokens_wiped: tokensWiped };
}

// ---------------------------------------------------------------- part b

/** Member's provider-side ids per connector (Terra, Vital), read BEFORE anything is erased. */
export function providerIdsByConnector(rows: ConnectionRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (!(r.connector_id in repo.PROVIDER_ID_PATHS) || !r.provider_user_id) continue;
    const list = out.get(r.connector_id) ?? [];
    if (!list.includes(r.provider_user_id)) list.push(r.provider_user_id);
    out.set(r.connector_id, list);
  }
  return out;
}

async function runWebhookLog(
  sb: SupabaseClient,
  userId: string,
  providerIds: Map<string, string[]> | null,
): Promise<WebhookLogReport> {
  let deleted = 0;
  try {
    const d = await repo.deleteWebhookLogByMember(sb, userId);
    if (d.error) return { deleted, residual: null, error: 'DELETE_FAILED' };
    deleted += d.count ?? 0;
    for (const [connectorId, ids] of providerIds ?? new Map<string, string[]>()) {
      const p = await repo.deleteWebhookLogByProviderIds(sb, connectorId, ids);
      if (p.error) return { deleted, residual: null, error: 'DELETE_FAILED' };
      deleted += p.count ?? 0;
    }

    // Re-select the same filters.
    let residual = 0;
    const c = await repo.countWebhookLogByMember(sb, userId);
    if (c.error || typeof c.count !== 'number') return { deleted, residual: null, error: 'RESIDUAL_CHECK_FAILED' };
    residual += c.count;
    for (const [connectorId, ids] of providerIds ?? new Map<string, string[]>()) {
      const pc = await repo.countWebhookLogByProviderIds(sb, connectorId, ids);
      if (pc.error || typeof pc.count !== 'number') return { deleted, residual: null, error: 'RESIDUAL_CHECK_FAILED' };
      residual += pc.count;
    }
    // Without the member's provider ids, rows keyed by them cannot be ruled out.
    if (providerIds === null) return { deleted, residual: null, error: 'CONNECTIONS_READ_FAILED' };
    return { deleted, residual };
  } catch {
    return { deleted, residual: null, error: 'QUERY_FAILED' };
  }
}

// ---------------------------------------------------------------- part c

async function runPartnerInbox(sb: SupabaseClient, userId: string): Promise<PartnerInboxReport> {
  let deleted = 0;
  const scrubbedIds = new Set<string>();
  try {
    const d = await repo.deleteConfirmedInboxRows(sb, userId);
    if (d.error) return { deleted, scrubbed: 0, residual: null, error: 'DELETE_FAILED' };
    deleted = (d.data ?? []).length;

    const cl = await repo.clearInboxProposals(sb, userId);
    if (cl.error) return { deleted, scrubbed: 0, residual: null, error: 'UPDATE_FAILED' };
    for (const r of (cl.data ?? []) as Array<{ id: string }>) scrubbedIds.add(r.id);

    const rows = await repo.fetchInboxRowsWithMemberInArrays(sb, userId);
    if (rows.error) return { deleted, scrubbed: scrubbedIds.size, residual: null, error: 'READ_FAILED' };
    for (const row of (rows.data ?? []) as Array<{ id: string; candidate_user_ids: string[] | null; member_declined_user_ids: string[] | null }>) {
      const u = await repo.updateInboxArrays(sb, row.id, {
        candidate_user_ids: (row.candidate_user_ids ?? []).filter((x) => x !== userId),
        member_declined_user_ids: (row.member_declined_user_ids ?? []).filter((x) => x !== userId),
      });
      if (u.error) return { deleted, scrubbed: scrubbedIds.size, residual: null, error: 'UPDATE_FAILED' };
      scrubbedIds.add(row.id);
    }

    const c = await repo.countInboxResidual(sb, userId);
    if (c.error || typeof c.count !== 'number') {
      return { deleted, scrubbed: scrubbedIds.size, residual: null, error: 'RESIDUAL_CHECK_FAILED' };
    }
    return { deleted, scrubbed: scrubbedIds.size, residual: c.count };
  } catch {
    return { deleted, scrubbed: scrubbedIds.size, residual: null, error: 'QUERY_FAILED' };
  }
}

// ---------------------------------------------------------------- route

const router = Router();

router.post('/member-residue', requireServiceOrAdmin, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: emits health.erasure.vendor_revoke and health.erasure.member_residue below.
  const userId = (req.body as { user_id?: unknown } | undefined)?.user_id;
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return res.status(400).json({ ok: false, error: 'INVALID_USER_ID' });
  }
  if (isStagingEnv()) {
    return res.status(409).json({ ok: false, error: 'STAGING_READ_ONLY' });
  }
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  // Part a reads first: part b needs the provider ids before anything is erased.
  let rows: ConnectionRow[] | null = null;
  try {
    const { data, error } = await repo.fetchMemberConnections(sb, userId);
    if (!error) rows = (data ?? []) as ConnectionRow[];
  } catch {
    rows = null;
  }

  const vendor = rows === null
    ? { entries: [] as VendorRevokeEntry[], tokens_wiped: false }
    : await runVendorRevoke(sb, rows, userId, VENDOR_REVOKE_TOTAL_CAP_MS);

  if (rows === null || vendor.entries.length > 0) {
    const anyFailed = rows === null || vendor.entries.some((e) => e.status === 'failed' || e.status === 'skipped_timeout');
    await emitOasisEvent({
      vtid: HEALTH_ERASURE_VTID,
      type: 'health.erasure.vendor_revoke',
      source: 'gateway',
      status: anyFailed ? 'warning' : 'info',
      message: rows === null
        ? 'Account deletion vendor revoke: connections read failed'
        : `Account deletion vendor revoke: ${vendor.entries.length} connector(s)`,
      payload: {
        connections_read: rows !== null,
        tokens_wiped: vendor.tokens_wiped,
        connectors: vendor.entries.map((e) => ({ connector_id: e.connector_id, status: e.status })),
      },
    }).catch(() => {});
  }

  const webhookLog = await runWebhookLog(sb, userId, rows === null ? null : providerIdsByConnector(rows));
  const partnerInbox = await runPartnerInbox(sb, userId);
  const complete = webhookLog.residual === 0 && partnerInbox.residual === 0;

  await emitOasisEvent({
    vtid: HEALTH_ERASURE_VTID,
    type: 'health.erasure.member_residue',
    source: 'gateway',
    status: complete ? 'info' : 'warning',
    message: `Account deletion health residue: ${complete ? 'complete' : 'incomplete'}`,
    payload: {
      complete,
      webhook_log: { deleted: webhookLog.deleted, residual: webhookLog.residual, error: webhookLog.error ?? null },
      partner_inbox: {
        deleted: partnerInbox.deleted,
        scrubbed: partnerInbox.scrubbed,
        residual: partnerInbox.residual,
        error: partnerInbox.error ?? null,
      },
      vendor_revoke_connectors: vendor.entries.length,
    },
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    vendor_revoke: vendor.entries,
    tokens_wiped: vendor.tokens_wiped,
    webhook_log: webhookLog,
    partner_inbox: partnerInbox,
    complete,
  });
});

export default router;
