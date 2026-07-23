/**
 * Admin Feature Announcements API — Publish News Feed "Brand New Feature" /
 * "Did You Know" cards (BOOTSTRAP-FEATURE-ANNOUNCEMENTS)
 *
 * Endpoints:
 * - POST /            — Create + publish an announcement: writes the row
 *                        every tenant member's feed will read (RLS-scoped),
 *                        and fans out an in-app + push notification to every
 *                        member of the tenant, in their own locale. Pass
 *                        `recipient_ids` to scope both the row's visibility
 *                        and the notification to specific users only — a
 *                        staged test send before widening to the whole
 *                        tenant (re-POST without `recipient_ids` for that).
 * - GET  /             — List announcements (most recent first) for admin review.
 *
 * Security:
 * - All endpoints require Bearer token + exafy_admin (mirrors admin-notifications.ts).
 *
 * Recipient text is resolved per-user locale via bulkGetUserLocales — the
 * announcement row stores feature_title/description as { en, de } (mirrors
 * how FeatureAnnouncementCard already takes plain, caller-localized props);
 * the notification title wraps the resolved feature name in the gateway's
 * generic `notif.feature_announcement.title` catalog key, the body IS the
 * per-locale description directly (one-off editorial copy, not a catalog key).
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { notifyUsersAsync, NotificationPayload } from '../services/notification-service';
import { bulkGetUserLocales } from '../i18n/server-locale';
import { tt, type GatewayLocale } from '../i18n/catalog';
import { requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

const router = Router();
const VTID = 'ADMIN-FEATURE-ANNOUNCEMENTS';

router.use(requireExafyAdmin);

interface LocalizedText {
  en: string;
  de: string;
  [locale: string]: string | undefined;
}

function pickLocale(text: LocalizedText, locale: GatewayLocale): string {
  return text[locale] ?? text.en ?? text.de ?? '';
}

// ── POST / — Create + publish an announcement ────────────────

router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const email = req.identity?.email || 'unknown';
  const {
    tenant_id,
    variant,        // 'brand-new-feature' | 'did-you-know-feature'
    feature_title,  // { en, de }
    description,    // { en, de }
    deep_link,
    recipient_ids,  // optional — staged test send scoped to these users only
  } = req.body as {
    tenant_id?: string;
    variant?: string;
    feature_title?: LocalizedText;
    description?: LocalizedText;
    deep_link?: string;
    recipient_ids?: string[];
  };

  if (!tenant_id || !variant || !feature_title?.en || !feature_title?.de ||
      !description?.en || !description?.de || !deep_link) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'tenant_id, variant, feature_title.{en,de}, description.{en,de}, and deep_link are required',
    });
  }
  if (variant !== 'brand-new-feature' && variant !== 'did-you-know-feature') {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'variant must be brand-new-feature or did-you-know-feature' });
  }

  try {
    const isTestSend = Array.isArray(recipient_ids) && recipient_ids.length > 0;

    // 1. Write the row. Visible to every tenant member's News Feed
    //    (RLS-scoped to their own tenant_id via user_tenants) unless this is
    //    a staged test send, in which case target_user_ids restricts SELECT
    //    (and the notification fan-out below) to just those users.
    const { data: inserted, error: insertError } = await supabase
      .from('feature_announcements')
      .insert({
        tenant_id,
        variant,
        feature_title,
        description,
        deep_link,
        created_by: email,
        target_user_ids: isTestSend ? recipient_ids : null,
      })
      .select('id')
      .single();

    if (insertError || !inserted) {
      console.error(`[${VTID}] insert failed:`, insertError?.message);
      return res.status(500).json({ ok: false, error: insertError?.message || 'INSERT_FAILED' });
    }
    const announcementId = inserted.id as string;

    // 2. Recipients — either the explicit test list, or everyone in the tenant.
    let targetUserIds: string[];
    if (isTestSend) {
      targetUserIds = recipient_ids as string[];
    } else {
      const { data: members, error: membersError } = await supabase
        .from('user_tenants')
        .select('user_id')
        .eq('tenant_id', tenant_id);

      if (membersError) {
        console.error(`[${VTID}] members lookup error:`, membersError.message);
        return res.status(500).json({ ok: false, error: membersError.message });
      }
      targetUserIds = (members || []).map((m: any) => m.user_id as string);
    }

    if (targetUserIds.length === 0) {
      return res.json({ ok: true, announcement_id: announcementId, sent_to: 0, message: 'No members in tenant — announcement published with no recipients' });
    }

    // 3. Resolve each recipient's locale, then fan out one batch per locale
    //    so every user gets the title/body in their own language (per
    //    platform CLAUDE.md §13b — gateway-emitted text must never be
    //    hardcoded to one locale for everyone).
    const locales = await bulkGetUserLocales(supabase, targetUserIds);
    const groups = new Map<GatewayLocale, string[]>();
    for (const uid of targetUserIds) {
      const lc = locales.get(uid) || 'de';
      const group = groups.get(lc) ?? [];
      group.push(uid);
      groups.set(lc, group);
    }

    for (const [locale, userIds] of groups) {
      const payload: NotificationPayload = {
        title: tt('notif.feature_announcement.title', locale, { feature: pickLocale(feature_title, locale) }),
        body: pickLocale(description, locale),
        data: { url: deep_link, entity_id: announcementId },
      };
      notifyUsersAsync(userIds, tenant_id, 'feature_announcement', payload, supabase);
    }

    await supabase
      .from('feature_announcements')
      .update({ notified_at: new Date().toISOString() })
      .eq('id', announcementId);

    console.log(
      `[${VTID}] ${isTestSend ? 'Test-published' : 'Published'} announcement ${announcementId} by ${email} ` +
      `to ${targetUserIds.length} user(s) across ${groups.size} locale(s)`,
    );

    return res.json({
      ok: true,
      announcement_id: announcementId,
      test_send: isTestSend,
      sent_to: targetUserIds.length,
      locales: [...groups.keys()],
    });
  } catch (err: any) {
    console.error(`[${VTID}] POST / exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET / — List announcements (admin review) ────────────────

router.get('/', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { tenant_id } = req.query;

  try {
    let query = supabase
      .from('feature_announcements')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (tenant_id && typeof tenant_id === 'string') {
      query = query.eq('tenant_id', tenant_id);
    }
    const { data, error } = await query;
    if (error) {
      console.error(`[${VTID}] GET / error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.json({ ok: true, data: data || [] });
  } catch (err: any) {
    console.error(`[${VTID}] GET / exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
