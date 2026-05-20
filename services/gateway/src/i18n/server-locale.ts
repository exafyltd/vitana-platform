// getUserLocale — resolves a user's preferred locale from server-side state.
//
// Sources, in priority order:
//   1. app_users.locale (canonical, set by /settings/Preferences profile updates)
//   2. memory_facts where fact_key='preferred_language' (assistant-inferred)
//   3. GATEWAY_DEFAULT_LOCALE ('de')
//
// Results are cached in-process for 5 minutes per user to avoid hammering
// Supabase from cron jobs that fan out over thousands of users.

import type { SupabaseClient } from '@supabase/supabase-js';
import { GATEWAY_DEFAULT_LOCALE, normalizeLocale, type GatewayLocale } from './catalog';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { locale: GatewayLocale; expires_at: number }>();

export async function getUserLocale(
  supa: SupabaseClient,
  userId: string,
): Promise<GatewayLocale> {
  if (!userId) return GATEWAY_DEFAULT_LOCALE;

  const cached = cache.get(userId);
  if (cached && cached.expires_at > Date.now()) return cached.locale;

  let resolved: GatewayLocale = GATEWAY_DEFAULT_LOCALE;
  try {
    const { data } = await supa
      .from('app_users')
      .select('locale')
      .eq('user_id', userId)
      .maybeSingle();
    const raw = (data as { locale?: string | null } | null)?.locale ?? null;
    if (raw) {
      resolved = normalizeLocale(raw);
    } else {
      // Fallback: check memory_facts
      const { data: factRow } = await supa
        .from('memory_facts')
        .select('fact_value')
        .eq('user_id', userId)
        .eq('fact_key', 'preferred_language')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const factValue = (factRow as { fact_value?: string | null } | null)?.fact_value ?? null;
      if (factValue) resolved = normalizeLocale(factValue);
    }
  } catch (e) {
    // Never block notifications on locale lookup
    console.warn(`[i18n] getUserLocale fallback for ${userId}:`, e);
  }

  cache.set(userId, { locale: resolved, expires_at: Date.now() + TTL_MS });
  return resolved;
}

/** Bulk variant — pre-fetches all users' locales in one query. */
export async function bulkGetUserLocales(
  supa: SupabaseClient,
  userIds: string[],
): Promise<Map<string, GatewayLocale>> {
  const out = new Map<string, GatewayLocale>();
  if (userIds.length === 0) return out;

  // Use cache first
  const now = Date.now();
  const missing: string[] = [];
  for (const uid of userIds) {
    const c = cache.get(uid);
    if (c && c.expires_at > now) out.set(uid, c.locale);
    else missing.push(uid);
  }
  if (missing.length === 0) return out;

  try {
    const { data } = await supa
      .from('app_users')
      .select('user_id, locale')
      .in('user_id', missing);
    const rows = (data ?? []) as Array<{ user_id: string; locale: string | null }>;
    const seen = new Set<string>();
    for (const row of rows) {
      const lc = normalizeLocale(row.locale);
      out.set(row.user_id, lc);
      cache.set(row.user_id, { locale: lc, expires_at: now + TTL_MS });
      seen.add(row.user_id);
    }
    for (const uid of missing) {
      if (!seen.has(uid)) {
        out.set(uid, GATEWAY_DEFAULT_LOCALE);
        cache.set(uid, { locale: GATEWAY_DEFAULT_LOCALE, expires_at: now + TTL_MS });
      }
    }
  } catch (e) {
    console.warn('[i18n] bulkGetUserLocales fallback:', e);
    for (const uid of missing) {
      if (!out.has(uid)) out.set(uid, GATEWAY_DEFAULT_LOCALE);
    }
  }
  return out;
}

export function invalidateUserLocale(userId: string): void {
  cache.delete(userId);
}
