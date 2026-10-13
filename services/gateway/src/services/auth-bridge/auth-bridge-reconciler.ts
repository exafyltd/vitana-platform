/**
 * VTID-05023 part 4, layer (c): reconciliation between Supabase auth.users
 * (GoTrue admin API) and Aurora's `public`, every 5 minutes. Catches what the
 * auth.users webhook missed (pg_net is fire-and-forget) and the gap between
 * disabling the Supabase triggers and the webhook going live.
 *
 * Off unless AUTH_BRIDGE_RECONCILE_ENABLED=true, never on staging (staging
 * shares production's Supabase project).
 *
 * Provisioning: every auth user created at or after AUTH_BRIDGE_RECONCILE_SINCE
 * (ISO timestamp, the start of the final full load; required — without it the
 * job provisions nobody and says so) that has no app_users row gets
 * ensure_provisioned(). Older users are never touched: they were provisioned
 * by the Supabase triggers and copied by the final load, and a missing row
 * there is history, not a gap this job may fill. Registered test/service accounts are skipped by
 * auth_bridge_unprovisioned() (CLAUDE.md rules 43-45).
 *
 * Deletion: a profiles row whose user is absent from the complete GoTrue
 * listing, AND for whom GoTrue answers 404 on a direct lookup, AND that
 * auth_bridge_handle_deleted_user() has not processed yet, is cleaned up the
 * way the Supabase cascade did. If more candidates than
 * AUTH_BRIDGE_RECONCILE_MAX_DELETES (default 20) appear in one run, the run
 * deletes nothing and logs an error: that pattern means a listing problem,
 * not a burst of account deletions. Any failed GoTrue page aborts the run
 * before the deletion phase.
 */

import {
  AuthBridgeDeps,
  BridgeAuthUser,
  getAuthBridgeDeps,
  provisionAuthUser,
} from './auth-bridge';

export const RECONCILE_INTERVAL_MS = 5 * 60_000;
export const RECONCILE_FIRST_DELAY_MS = 60_000;
const DEFAULT_PER_PAGE = 1000;
const DEFAULT_MAX_PAGES = 1000;
const DEFAULT_MAX_DELETES = 20;
const PROFILE_PAGE = 1000;

export interface ReconcileOptions {
  since: Date | null;
  perPage?: number;
  maxPages?: number;
  maxDeletes?: number;
  now?: Date;
}

export interface ReconcileSummary {
  ok: boolean;
  auth_users_seen: number;
  pages: number;
  provisioned: string[];
  provision_errors: Record<string, string>;
  deleted: string[];
  delete_errors: Record<string, string>;
  deletion_candidates: number;
  deletion_skipped_reason: string | null;
  error: string | null;
}

export function isAuthBridgeReconcileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AUTH_BRIDGE_RECONCILE_ENABLED || '').trim().toLowerCase() === 'true';
}

export function reconcileOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ReconcileOptions {
  const raw = (env.AUTH_BRIDGE_RECONCILE_SINCE || '').trim();
  const since = raw ? new Date(raw) : null;
  const maxDeletes = Number.parseInt(env.AUTH_BRIDGE_RECONCILE_MAX_DELETES || '', 10);
  return {
    since: since && !Number.isNaN(since.getTime()) ? since : null,
    maxDeletes: Number.isFinite(maxDeletes) && maxDeletes >= 0 ? maxDeletes : DEFAULT_MAX_DELETES,
  };
}

function createdAtOrAfter(user: BridgeAuthUser, since: Date): boolean {
  if (!user.created_at) return false;
  const t = new Date(user.created_at).getTime();
  return !Number.isNaN(t) && t >= since.getTime();
}

/** One reconciliation pass. Never throws; the summary says what happened. */
export async function reconcileAuthBridge(deps: AuthBridgeDeps, opts: ReconcileOptions): Promise<ReconcileSummary> {
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const maxDeletes = opts.maxDeletes ?? DEFAULT_MAX_DELETES;
  const summary: ReconcileSummary = {
    ok: false,
    auth_users_seen: 0,
    pages: 0,
    provisioned: [],
    provision_errors: {},
    deleted: [],
    delete_errors: {},
    deletion_candidates: 0,
    deletion_skipped_reason: null,
    error: null,
  };

  if (!opts.since) {
    console.error('[VTID-05023] auth-bridge reconcile: AUTH_BRIDGE_RECONCILE_SINCE is unset or invalid — provisioning nobody');
  }

  // Phase 1: page GoTrue; provision missing users created since the flip.
  const authIds = new Set<string>();
  try {
    let complete = false;
    for (let page = 1; page <= maxPages; page++) {
      const users = await deps.gotrue.listUsers(page, perPage);
      summary.pages = page;
      for (const u of users) authIds.add(u.id);
      if (opts.since) {
        const recent = users.filter((u) => createdAtOrAfter(u, opts.since as Date));
        const missing = new Set(await deps.store.unprovisioned(recent.map((u) => u.id)));
        for (const user of recent) {
          if (!missing.has(user.id)) continue;
          try {
            await provisionAuthUser(deps, user);
            summary.provisioned.push(user.id);
          } catch (err: any) {
            summary.provision_errors[user.id] = err?.message ?? String(err);
          }
        }
      }
      if (users.length < perPage) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new Error(`GoTrue listing exceeded ${maxPages} pages of ${perPage}`);
  } catch (err: any) {
    summary.auth_users_seen = authIds.size;
    summary.error = `listing auth users failed, deletion phase skipped: ${err?.message ?? err}`;
    summary.deletion_skipped_reason = 'incomplete_listing';
    console.error(`[VTID-05023] auth-bridge reconcile: ${summary.error}`);
    return summary;
  }
  summary.auth_users_seen = authIds.size;

  // Phase 2: profiles whose auth user is gone.
  try {
    const candidates: string[] = [];
    for (let offset = 0; ; offset += PROFILE_PAGE) {
      const ids = await deps.store.listProfileUserIds(offset, PROFILE_PAGE);
      for (const id of ids) if (!authIds.has(id)) candidates.push(id);
      if (ids.length < PROFILE_PAGE) break;
    }
    const processed = new Set<string>();
    for (let i = 0; i < candidates.length; i += 200) {
      for (const id of await deps.store.processedDeletions(candidates.slice(i, i + 200))) processed.add(id);
    }
    const pending = candidates.filter((id) => !processed.has(id));
    summary.deletion_candidates = pending.length;
    if (pending.length > maxDeletes) {
      summary.deletion_skipped_reason = `too_many_candidates (${pending.length} > ${maxDeletes})`;
      console.error(
        `[VTID-05023] auth-bridge reconcile: ${pending.length} profiles have no auth user (limit ${maxDeletes}) — ` +
          'deleting nothing; check the GoTrue listing before raising AUTH_BRIDGE_RECONCILE_MAX_DELETES',
      );
    } else {
      for (const id of pending) {
        try {
          const user = await deps.gotrue.getUser(id);
          if (user) continue; // created after the listing, or listed late: not deleted
          await deps.store.handleDeletedUser(id, 'reconciler');
          summary.deleted.push(id);
        } catch (err: any) {
          summary.delete_errors[id] = err?.message ?? String(err);
        }
      }
    }
  } catch (err: any) {
    summary.error = `deletion phase failed: ${err?.message ?? err}`;
    console.error(`[VTID-05023] auth-bridge reconcile: ${summary.error}`);
    return summary;
  }

  summary.ok = Object.keys(summary.provision_errors).length === 0 && Object.keys(summary.delete_errors).length === 0;
  const line =
    `[VTID-05023] auth-bridge reconcile: ${summary.auth_users_seen} auth users, ` +
    `provisioned ${summary.provisioned.length}, deleted ${summary.deleted.length}` +
    (summary.deletion_skipped_reason ? `, deletion skipped (${summary.deletion_skipped_reason})` : '');
  if (summary.ok) console.log(line);
  else console.error(`${line}, errors: ${JSON.stringify({ ...summary.provision_errors, ...summary.delete_errors })}`);
  return summary;
}

let loopStarted = false;

/** Starts the 5-minute loop. Returns whether it started. */
export function startAuthBridgeReconcileLoop(env: NodeJS.ProcessEnv = process.env): boolean {
  if (loopStarted || !isAuthBridgeReconcileEnabled(env)) return false;
  if ((env.VITANA_ENV || '').toLowerCase() === 'staging') {
    console.warn('[VTID-05023] auth-bridge reconcile: refusing to run on staging (shares production Supabase)');
    return false;
  }
  loopStarted = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const deps = getAuthBridgeDeps(env);
      if (!deps) {
        console.error('[VTID-05023] auth-bridge reconcile: no Supabase service credentials — skipped');
        return;
      }
      await reconcileAuthBridge(deps, reconcileOptionsFromEnv(env));
    } catch (err: any) {
      console.error(`[VTID-05023] auth-bridge reconcile tick failed: ${err?.message ?? err}`);
    } finally {
      running = false;
    }
  };
  setTimeout(() => { void tick(); }, RECONCILE_FIRST_DELAY_MS).unref?.();
  setInterval(() => { void tick(); }, RECONCILE_INTERVAL_MS).unref?.();
  return true;
}
