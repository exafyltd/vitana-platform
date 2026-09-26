/**
 * VTID-04674: one delivery decision for every notification.
 *
 * A notification reaches a person only if
 *   1. the admin has its type switched on for the tenant
 *      (and, when an automation sent it, that automation too),
 *   2. the member has not switched off the category the type belongs to,
 *   3. for push: the member's push switch is on and it is outside their
 *      quiet hours (P0 bypasses quiet hours, as before).
 *
 * The database guard (trigger on user_notifications) applies 1 and 2 to every
 * row, including rows written by database triggers. This module applies the
 * same rule in the gateway, because push-only notifications and reminders
 * never write a row, and because a push must not go out for a row the guard
 * dropped.
 *
 * Failure posture: if the switch cannot be read, the notification is allowed
 * and the error is logged loudly — the same posture as the database guard.
 * A missed switch read must not silence account and safety messages.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import * as repo from './notification-controls-repository';
import { fetchUserNotificationPreferences } from '../notification-service-repository';
import {
  NOTIFICATION_CATALOG,
  LOCALIZED_AUTOMATION_DOMAINS,
  catalogEntryFor,
  type NotificationAudience,
  type NotificationCatalogEntry,
  type TextReadiness,
} from './notification-catalog';
import { getAutomation } from '../automation-registry';
import { emitOasisEvent } from '../oasis-event-service';

type Sb = SupabaseClient<any, any, any>;

export const VTID = 'VTID-04674';

// ── Switch lookup (cached) ───────────────────────────────────────────────────

/** How long a switch value is reused. A change made on another gateway task
 *  reaches this one within this window. */
export const CONTROL_CACHE_TTL_MS = 30_000;

const allowedCache = new Map<string, { allowed: boolean; expires: number }>();
const lastErrorLog = new Map<string, number>();

function logThrottled(key: string, message: string): void {
  const now = Date.now();
  if ((lastErrorLog.get(key) ?? 0) > now - 60_000) return;
  lastErrorLog.set(key, now);
  console.error(message);
}

function cacheKey(tenantId: string, type: string, sourceKey: string): string {
  return `${tenantId}|${type}|${sourceKey}`;
}

/** Test hook and post-write invalidation. */
export function clearNotificationControlCache(tenantId?: string, type?: string): void {
  if (!tenantId) {
    allowedCache.clear();
    return;
  }
  for (const key of allowedCache.keys()) {
    if (key.startsWith(`${tenantId}|${type ?? ''}`)) allowedCache.delete(key);
  }
}

export function normalizeSourceKey(sourceKey: unknown): string {
  return typeof sourceKey === 'string' ? sourceKey.trim() : '';
}

/**
 * Is this type switched on by the admin for this tenant (and for this
 * automation, when one sent it)? A type never seen before is registered as
 * OFF by the database and answers false.
 */
export async function isNotificationTypeAllowed(
  sb: Sb,
  tenantId: string,
  type: string,
  sourceKey: string = '',
): Promise<boolean> {
  if (!tenantId || !type) {
    logThrottled('no-tenant', `[notification-controls] switch check without tenant/type (type=${type}) — allowed`);
    return true;
  }
  const source = normalizeSourceKey(sourceKey);
  const key = cacheKey(tenantId, type, source);
  const hit = allowedCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.allowed;

  try {
    const { data, error } = await repo.rpcTypeAllowed(sb, tenantId, type, source);
    if (error) throw new Error(error.message);
    const allowed = data !== false;
    allowedCache.set(key, { allowed, expires: Date.now() + CONTROL_CACHE_TTL_MS });
    return allowed;
  } catch (err: any) {
    logThrottled(
      `rpc:${err?.message}`,
      `[notification-controls] ERROR reading the admin switch for ${type} — allowed (fail open): ${err?.message || err}`,
    );
    return true;
  }
}

/**
 * Has the member left the category of this type switched on? Returns null
 * when the answer could not be read, so the caller can fall back.
 */
export async function isMemberCategoryAllowed(
  sb: Sb,
  userId: string,
  tenantId: string,
  type: string,
): Promise<boolean | null> {
  try {
    const { data, error } = await repo.rpcMemberAllows(sb, userId, tenantId, type);
    if (error) throw new Error(error.message);
    return data !== false;
  } catch (err: any) {
    logThrottled(
      `member:${err?.message}`,
      `[notification-controls] ERROR reading the member category switch for ${type}: ${err?.message || err}`,
    );
    return null;
  }
}

/** Counts a notification that was not created. Never throws, never awaited by senders. */
export function recordNotificationBlock(
  sb: Sb,
  tenantId: string,
  type: string,
  sourceKey: string,
  reason: 'admin_off' | 'member_off',
): void {
  if (!tenantId || !type) return;
  Promise.resolve(repo.rpcRecordBlock(sb, tenantId, type, normalizeSourceKey(sourceKey), reason))
    .then((res: any) => {
      if (res?.error) logThrottled(`block:${res.error.message}`, `[notification-controls] block counter failed: ${res.error.message}`);
    })
    .catch((err: any) => logThrottled(`block:${err?.message}`, `[notification-controls] block counter failed: ${err?.message}`));
}

// ── Push decision ────────────────────────────────────────────────────────────

export interface PushPrefs {
  push_enabled?: boolean | null;
  dnd_enabled?: boolean | null;
  dnd_start_time?: string | null;
  dnd_end_time?: string | null;
}

/** Quiet hours as "HH:MM" strings; spans past midnight (22:00–07:00) are handled. */
export function isInQuietHours(prefs: PushPrefs | null | undefined, now: Date = new Date()): boolean {
  if (!prefs?.dnd_enabled || !prefs.dnd_start_time || !prefs.dnd_end_time) return false;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const start = prefs.dnd_start_time.slice(0, 5);
  const end = prefs.dnd_end_time.slice(0, 5);
  if (start > end) return hhmm >= start || hhmm < end;
  return hhmm >= start && hhmm < end;
}

export type PushBlockReason = 'admin_disabled' | 'member_category_off' | 'push_disabled' | 'quiet_hours';

/**
 * The full rule for a push sent without going through notifyUser
 * (reminders). Pass `prefs` when already loaded; undefined loads them.
 */
export async function decidePushDelivery(
  sb: Sb,
  input: {
    userId: string;
    tenantId: string;
    type: string;
    priority?: string;
    sourceKey?: string;
    prefs?: PushPrefs | null;
    checkMemberCategory?: boolean;
  },
): Promise<{ send: boolean; reason?: PushBlockReason }> {
  const source = normalizeSourceKey(input.sourceKey);
  if (!(await isNotificationTypeAllowed(sb, input.tenantId, input.type, source))) {
    recordNotificationBlock(sb, input.tenantId, input.type, source, 'admin_off');
    return { send: false, reason: 'admin_disabled' };
  }
  if (input.checkMemberCategory !== false) {
    const member = await isMemberCategoryAllowed(sb, input.userId, input.tenantId, input.type);
    if (member === false) {
      recordNotificationBlock(sb, input.tenantId, input.type, '', 'member_off');
      return { send: false, reason: 'member_category_off' };
    }
  }
  let prefs = input.prefs;
  if (prefs === undefined) {
    const { data, error } = await fetchUserNotificationPreferences(sb, input.userId, input.tenantId);
    if (error && error.code !== 'PGRST116') {
      logThrottled(`prefs:${error.message}`, `[notification-controls] prefs read failed (defaults used): ${error.message}`);
    }
    prefs = (data as PushPrefs | null) ?? null;
  }
  if (prefs?.push_enabled === false) return { send: false, reason: 'push_disabled' };
  if (input.priority !== 'p0' && isInQuietHours(prefs)) return { send: false, reason: 'quiet_hours' };
  return { send: true };
}

// ── Admin screen ─────────────────────────────────────────────────────────────

export function automationReadiness(sourceKey: string): TextReadiness {
  const def = getAutomation(sourceKey);
  if (!def) return 'unverified';
  return LOCALIZED_AUTOMATION_DOMAINS.has(def.domain) ? 'ready' : 'not_localized';
}

export interface ControlStats {
  sent: number;
  pushed: number;
  read: number;
  blocked_admin: number;
  blocked_member: number;
  last_sent_at: string | null;
}

export interface NotificationControlView extends NotificationCatalogEntry {
  in_catalog: boolean;
  enabled: boolean;
  auto_registered: boolean;
  registered: boolean;
  reason: string | null;
  updated_at: string | null;
  updated_by_email: string | null;
  can_enable: boolean;
  category: { id: string; slug: string | null; name: string | null; member_can_disable: boolean } | null;
  automations: Array<{
    source_key: string;
    name: string | null;
    enabled: boolean;
    auto_registered: boolean;
    text: TextReadiness;
    can_enable: boolean;
    updated_at: string | null;
    updated_by_email: string | null;
  }>;
  stats: ControlStats | null;
}

const EMPTY_STATS: ControlStats = {
  sent: 0, pushed: 0, read: 0, blocked_admin: 0, blocked_member: 0, last_sent_at: null,
};

export async function listNotificationControls(
  sb: Sb,
  tenantId: string,
  days: number = 7,
): Promise<{
  controls: NotificationControlView[];
  stats_error: string | null;
  categories_error: string | null;
  audience: Record<NotificationAudience, number | null>;
}> {
  const [controlsRes, statsRes, catsRes, audience] = await Promise.all([
    repo.fetchControls(sb, tenantId),
    repo.rpcTypeStats(sb, tenantId, days),
    repo.fetchActiveCategoriesForTenant(sb, tenantId),
    estimateAudiences(sb, tenantId),
  ]);
  if (controlsRes.error) throw new Error(`notification_type_controls read failed: ${controlsRes.error.message}`);

  const rows = (controlsRes.data || []) as any[];
  const statsByType = new Map<string, ControlStats>();
  for (const s of (statsRes.data || []) as any[]) {
    statsByType.set(s.type, {
      sent: Number(s.sent) || 0,
      pushed: Number(s.pushed) || 0,
      read: Number(s.read) || 0,
      blocked_admin: Number(s.blocked_admin) || 0,
      blocked_member: Number(s.blocked_member) || 0,
      last_sent_at: s.last_sent_at ?? null,
    });
  }
  const categoryByType = new Map<string, NotificationControlView['category']>();
  for (const c of (catsRes.data || []) as any[]) {
    const types: string[] = Array.isArray(c.mapped_types) ? c.mapped_types : [];
    for (const t of types) {
      // A tenant's own category wins over a global one for the same type.
      if (categoryByType.has(t) && !c.tenant_id) continue;
      categoryByType.set(t, {
        id: c.id,
        slug: c.slug ?? null,
        name: c.display_name ?? null,
        member_can_disable: c.member_can_disable !== false,
      });
    }
  }

  const typeKeys = new Set<string>(NOTIFICATION_CATALOG.keys());
  for (const r of rows) typeKeys.add(r.type);
  for (const t of statsByType.keys()) typeKeys.add(t);

  const controls: NotificationControlView[] = [];
  for (const type of typeKeys) {
    const entry = catalogEntryFor(type);
    const own = rows.find((r) => r.type === type && (r.source_key || '') === '');
    const automations = rows
      .filter((r) => r.type === type && (r.source_key || '') !== '')
      .map((r) => {
        const text = automationReadiness(r.source_key);
        return {
          source_key: r.source_key,
          name: getAutomation(r.source_key)?.name ?? null,
          enabled: r.enabled === true,
          auto_registered: r.auto_registered === true,
          text,
          can_enable: text !== 'not_localized',
          updated_at: r.updated_at ?? null,
          updated_by_email: r.updated_by_email ?? null,
        };
      })
      .sort((a, b) => a.source_key.localeCompare(b.source_key));

    controls.push({
      ...entry,
      in_catalog: NOTIFICATION_CATALOG.has(type),
      enabled: own?.enabled === true,
      auto_registered: own?.auto_registered === true,
      registered: !!own,
      reason: own?.reason ?? null,
      updated_at: own?.updated_at ?? null,
      updated_by_email: own?.updated_by_email ?? null,
      can_enable: entry.text !== 'not_localized',
      category: categoryByType.get(type) ?? null,
      automations,
      stats: statsRes.error ? null : statsByType.get(type) ?? { ...EMPTY_STATS },
    });
  }
  controls.sort((a, b) =>
    a.audience.localeCompare(b.audience) || a.group.localeCompare(b.group) || a.type.localeCompare(b.type));

  return {
    controls,
    stats_error: statsRes.error ? statsRes.error.message : null,
    categories_error: catsRes.error ? catsRes.error.message : null,
    audience,
  };
}

const AUDIENCE_ROLE: Record<NotificationAudience, string | undefined> = {
  member: undefined,
  admin: 'admin',
  developer: 'developer',
  staff: 'staff',
};

/** About how many people a type reaches when switched on (null = could not count). */
export async function estimateAudiences(
  sb: Sb,
  tenantId: string,
): Promise<Record<NotificationAudience, number | null>> {
  const entries = await Promise.all(
    (Object.keys(AUDIENCE_ROLE) as NotificationAudience[]).map(async (aud) => {
      try {
        const { count, error } = await repo.countTenantMembers(sb, tenantId, AUDIENCE_ROLE[aud]);
        return [aud, error ? null : count ?? null] as const;
      } catch {
        return [aud, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries) as Record<NotificationAudience, number | null>;
}

const TYPE_RE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/i;
const SOURCE_RE = /^AP-\d{4}$/;

export class NotificationControlError extends Error {
  constructor(public code: 'invalid_input' | 'not_localized' | 'write_failed', message: string) {
    super(message);
  }
}

export async function setNotificationControl(
  sb: Sb,
  input: {
    tenantId: string;
    type: string;
    sourceKey?: string;
    enabled: boolean;
    reason?: string | null;
    actorUserId?: string | null;
    actorEmail?: string | null;
  },
): Promise<{ type: string; source_key: string; old_enabled: boolean | null; new_enabled: boolean }> {
  const type = (input.type || '').trim();
  const sourceKey = normalizeSourceKey(input.sourceKey);
  if (!TYPE_RE.test(type)) throw new NotificationControlError('invalid_input', 'type is not a valid notification type');
  if (sourceKey && !SOURCE_RE.test(sourceKey)) {
    throw new NotificationControlError('invalid_input', 'source_key must be empty or an automation id like AP-0101');
  }
  if (typeof input.enabled !== 'boolean') throw new NotificationControlError('invalid_input', 'enabled must be true or false');
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : null;

  if (input.enabled) {
    const text = sourceKey ? automationReadiness(sourceKey) : catalogEntryFor(type).text;
    if (text === 'not_localized') {
      throw new NotificationControlError(
        'not_localized',
        'This notification is written in English only. Translate its text before switching it on.',
      );
    }
  }

  const { data: before, error: readErr } = await repo.fetchControl(sb, input.tenantId, type, sourceKey);
  if (readErr) throw new NotificationControlError('write_failed', readErr.message);
  const oldEnabled: boolean | null = before ? before.enabled === true : null;

  const now = new Date().toISOString();
  const { error: writeErr } = await repo.upsertControl(sb, {
    tenant_id: input.tenantId,
    type,
    source_key: sourceKey,
    enabled: input.enabled,
    auto_registered: false,
    reason,
    updated_by: input.actorUserId ?? null,
    updated_by_email: input.actorEmail ?? null,
    updated_at: now,
  });
  if (writeErr) throw new NotificationControlError('write_failed', writeErr.message);
  clearNotificationControlCache(input.tenantId, type);

  const { error: auditErr } = await repo.insertAudit(sb, {
    tenant_id: input.tenantId,
    type,
    source_key: sourceKey,
    old_enabled: oldEnabled,
    new_enabled: input.enabled,
    reason,
    actor_user_id: input.actorUserId ?? null,
    actor_email: input.actorEmail ?? null,
  });
  if (auditErr) console.error(`[notification-controls] audit write failed for ${type}: ${auditErr.message}`);

  await emitOasisEvent({
    vtid: VTID,
    type: 'notification.control.changed',
    source: 'gateway',
    status: 'info',
    message: `Notification ${type}${sourceKey ? ` (${sourceKey})` : ''} switched ${input.enabled ? 'on' : 'off'}`,
    payload: {
      tenant_id: input.tenantId,
      type,
      source_key: sourceKey,
      old_enabled: oldEnabled,
      new_enabled: input.enabled,
      reason,
      audit_written: !auditErr,
    },
    actor_id: input.actorUserId ?? undefined,
    actor_email: input.actorEmail ?? undefined,
    actor_role: 'admin',
    surface: 'api',
  }).catch((err: any) => console.error(`[notification-controls] OASIS emit failed: ${err?.message}`));

  return { type, source_key: sourceKey, old_enabled: oldEnabled, new_enabled: input.enabled };
}

export async function getNotificationControlAudit(sb: Sb, tenantId: string, type: string, limit = 50) {
  const { data, error } = await repo.fetchAudit(sb, tenantId, type, Math.min(Math.max(limit, 1), 200));
  if (error) throw new Error(error.message);
  return data || [];
}

export async function getNotificationActivity(sb: Sb, tenantId: string, days = 30) {
  const { data, error } = await repo.rpcDailyActivity(sb, tenantId, Math.min(Math.max(days, 1), 90));
  if (error) throw new Error(error.message);
  return (data || []).map((r: any) => ({
    day: r.day,
    type: r.type,
    sent: Number(r.sent) || 0,
    pushed: Number(r.pushed) || 0,
    read: Number(r.read) || 0,
    blocked_admin: Number(r.blocked_admin) || 0,
    blocked_member: Number(r.blocked_member) || 0,
  }));
}
