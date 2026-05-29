// getUserLocale — resolves a user's preferred locale from server-side state.
//
// Sources, in priority order:
//   1. app_users.locale (canonical profile column — rarely populated today)
//   2. user_preferences.stt_language (the field the frontend Language picker
//      actually writes, e.g. 'en-US' — this is the live source for most users)
//   3. memory_facts where fact_key='preferred_language' (assistant-inferred)
//   4. GATEWAY_DEFAULT_LOCALE ('de')
//
// normalizeLocale() collapses 'en-US' → 'en', 'de-DE' → 'de', etc.
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
      // Fallback 1: user_preferences.stt_language — the column the frontend
      // Language picker writes (e.g. 'en-US'). This is what's actually
      // populated for most users today.
      const { data: prefRow } = await supa
        .from('user_preferences')
        .select('stt_language')
        .eq('user_id', userId)
        .maybeSingle();
      const stt = (prefRow as { stt_language?: string | null } | null)?.stt_language ?? null;
      if (stt) {
        resolved = normalizeLocale(stt);
      } else {
        // Fallback 2: memory_facts (assistant-inferred)
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
    // Pass 1: app_users.locale (only counts when non-null).
    const { data } = await supa
      .from('app_users')
      .select('user_id, locale')
      .in('user_id', missing);
    const rows = (data ?? []) as Array<{ user_id: string; locale: string | null }>;
    const resolvedIds = new Set<string>();
    for (const row of rows) {
      if (row.locale) {
        const lc = normalizeLocale(row.locale);
        out.set(row.user_id, lc);
        cache.set(row.user_id, { locale: lc, expires_at: now + TTL_MS });
        resolvedIds.add(row.user_id);
      }
    }

    // Pass 2: user_preferences.stt_language for everyone still unresolved —
    // this is the column the frontend Language picker actually writes.
    const stillMissing = missing.filter((uid) => !resolvedIds.has(uid));
    if (stillMissing.length > 0) {
      const { data: prefData } = await supa
        .from('user_preferences')
        .select('user_id, stt_language')
        .in('user_id', stillMissing);
      const prefRows = (prefData ?? []) as Array<{ user_id: string; stt_language: string | null }>;
      for (const row of prefRows) {
        if (row.stt_language) {
          const lc = normalizeLocale(row.stt_language);
          out.set(row.user_id, lc);
          cache.set(row.user_id, { locale: lc, expires_at: now + TTL_MS });
          resolvedIds.add(row.user_id);
        }
      }
    }

    // Anyone still unresolved → default.
    for (const uid of missing) {
      if (!resolvedIds.has(uid)) {
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
