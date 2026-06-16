#!/usr/bin/env -S npx tsx
/**
 * gen-desktop-nav-seed — BOOTSTRAP-NAV-DESKTOP-CATALOG
 *
 * Seeds the **Desktop MAXINA** catalog (platform='desktop') from an inventory of
 * the desktop web app's real, member-facing routes (vitana-v1/src/App.tsx).
 *
 * The desktop app is NOT the mobile app — it is fuller and uses different routes
 * (no mode-pills; pages with tabs). So this is its own catalog. For each desktop
 * screen we reuse the existing screen's category/access/i18n from
 * NAVIGATION_CATALOG (same logical screen, same copy) and override only the
 * ROUTE with the real desktop path, scoped to platform='desktop'. Five screens
 * are desktop-only (no existing catalog entry) and carry inline metadata + i18n.
 *
 * Excluded (per inventory): admin (/admin/*), dev hub (/dev/*), staff/professional/
 * patient role-gated routes, redirects/legacy aliases, and catch-alls.
 *
 * Additive + idempotent: upsert keyed on the (screen_id, platform) shared-unique
 * index. Run order: this seed assumes the platform column + per-platform indexes
 * already exist (migration 20260615120000).
 *
 * Usage:
 *   npx tsx scripts/gen-desktop-nav-seed.ts > ../../supabase/migrations/<ts>_nav_catalog_desktop.sql
 */
import { NAVIGATION_CATALOG } from '../src/lib/navigation-catalog';

type Lang = 'en' | 'de';
type Content = { title: string; description: string; when_to_visit: string };

// Desktop screen → real desktop route (corrected against App.tsx). Order = grouping.
const DESKTOP_ROUTES: Array<[string, string]> = [
  // HOME
  ['HOME.OVERVIEW', '/home'],
  ['SEARCH.OVERVIEW', '/search'],
  ['NEWS.DETAIL', '/news/:id'],
  // DISCOVER
  ['DISCOVER.OVERVIEW', '/discover'],
  ['DISCOVER.AI_PICKS', '/discover/ai-picks'],
  ['DISCOVER.MARKETPLACE', '/discover/marketplace'],
  ['DISCOVER.SUPPLEMENTS', '/discover/supplements'],
  ['DISCOVER.WELLNESS_SERVICES', '/discover/wellness-services'],
  ['DISCOVER.DOCTORS_COACHES', '/discover/doctors-coaches'],
  ['DISCOVER.DEALS', '/discover/deals-offers'],
  ['DISCOVER.ORDERS', '/discover/orders'],
  ['DISCOVER.PROVIDER_PROFILE', '/discover/provider/:id'],
  ['DISCOVER.PRODUCT_DETAIL', '/discover/product/:id'],
  ['DISCOVER.CART', '/universal-cart'],
  ['DISCOVER.SHOP', '/shop'],
  ['DISCOVER.MY_TICKETS', '/my-tickets'],
  // HEALTH
  ['HEALTH.OVERVIEW', '/health'],
  ['HEALTH.PILLARS', '/health/pillars'],
  ['HEALTH.SERVICES_HUB', '/health/services-hub'],
  ['HEALTH.CONDITIONS', '/health/conditions'],
  ['HEALTH.EDUCATION', '/health/education'],
  ['HEALTH.MY_BIOLOGY', '/health/my-biology'],
  ['HEALTH.PLANS', '/health/plans'],
  ['HEALTH.VITANA_INDEX', '/health/vitana-index'],
  ['MEMORY.DAILY_DIARY', '/daily-diary'],
  ['REMINDERS.OVERVIEW', '/reminders'],
  // COMMUNITY
  ['COMM.OVERVIEW', '/comm'],
  ['COMM.GROUPS', '/comm/groups'],
  ['COMM.GROUP_DETAIL', '/comm/groups/:id'],
  ['COMM.EVENTS', '/comm/events-meetups'],
  ['COMM.LIVE_ROOMS', '/comm/live-rooms'],
  ['COMM.LIVE_ROOM_VIEWER', '/comm/live-rooms/:roomId/view'],
  ['COMM.MEDIA_HUB', '/comm/media-hub'],
  ['COMM.MEMBERS', '/comm/members'],
  ['COMM.OPEN_ASKS', '/comm/open-asks'],
  ['COMM.FIND_PARTNER', '/comm/find-partner'],
  ['COMM.TALK_TO_VITANA', '/comm/talk-to-vitana'],
  ['INTENTS.BOARD', '/intents/board'],
  ['INTENTS.MINE', '/intents/mine'],
  ['INTENTS.MATCH_DETAIL', '/intents/match/:id'],
  ['COMM.MATCHES', '/me/matches'],
  ['COMM.INVITE', '/invite'],
  // BUSINESS
  ['BUSINESS.OVERVIEW', '/business'],
  ['BUSINESS.SERVICES', '/business/services'],
  ['BUSINESS.CLIENTS', '/business/clients'],
  ['BUSINESS.SELL_EARN', '/business/sell-earn'],
  ['BUSINESS.ANALYTICS', '/business/analytics'],
  ['BUSINESS.OPPORTUNITIES', '/business/opportunities'],
  ['BUSINESS.LISTINGS', '/business/listings'],
  // AI
  ['AI.OVERVIEW', '/ai'],
  ['AI.INSIGHTS', '/ai/insights'],
  ['AI.RECOMMENDATIONS', '/ai/recommendations'],
  ['AI.DAILY_SUMMARY', '/ai/daily-summary'],
  ['AI.COMPANION', '/ai/companion'],
  ['ASSISTANT.OVERVIEW', '/assistant'],
  ['AUTOPILOT.MY_JOURNEY', '/autopilot'],
  // INBOX
  ['INBOX.OVERVIEW', '/inbox'],
  ['INBOX.ARCHIVED', '/inbox/archived'],
  ['INBOX.INSPIRATION', '/inbox/inspiration'],
  // WALLET
  ['WALLET.OVERVIEW', '/wallet'],
  ['WALLET.BALANCE', '/wallet/balance'],
  ['WALLET.SUBSCRIPTIONS', '/wallet/subscriptions'],
  ['WALLET.REWARDS', '/wallet/rewards'],
  // MEMORY
  ['MEMORY.OVERVIEW', '/memory'],
  ['MEMORY.TIMELINE', '/memory/timeline'],
  ['MEMORY.DIARY', '/memory/diary'],
  ['MEMORY.RECALL', '/memory/recall'],
  ['MEMORY.PERMISSIONS', '/memory/permissions'],
  // SETTINGS
  ['SETTINGS.OVERVIEW', '/settings'],
  ['SETTINGS.PRIVACY', '/settings/privacy'],
  ['SETTINGS.NOTIFICATIONS', '/settings/notifications'],
  ['SETTINGS.PREFERENCES', '/settings/preferences'],
  ['SETTINGS.LIMITATIONS', '/settings/limitations'],
  ['SETTINGS.CONNECTED_APPS', '/connectors'],
  ['SETTINGS.SUPPORT', '/support'],
  ['SETTINGS.BILLING', '/settings/billing'],
  ['SETTINGS.TENANT_ROLE', '/settings/tenant-role'],
  ['PROFILE.ME', '/me/profile'],
  ['PROFILE.PRIVACY', '/profile/me/privacy'],
  // SHARING
  ['SHARING.OVERVIEW', '/sharing'],
  ['SHARING.CAMPAIGNS', '/sharing/campaigns'],
  ['SHARING.CAMPAIGN_DETAIL', '/sharing/campaigns/:id'],
  ['SHARING.DISTRIBUTION', '/sharing/distribution'],
  ['SHARING.DATA_CONSENT', '/sharing/data-consent'],
  // PUBLIC / AUTH
  ['PUBLIC.LANDING', '/'],
  ['PUBLIC.PRIVACY', '/privacy'],
  ['PUBLIC.TERMS', '/terms'],
  ['AUTH.MAXINA_PORTAL', '/maxina'],
  ['AUTH.ALKALMA_PORTAL', '/alkalma'],
  ['AUTH.EARTHLINKS_PORTAL', '/earthlinks'],
  ['PROFILE.PUBLIC', '/u/:identifier'],
];

// Desktop-only screens (no entry in NAVIGATION_CATALOG). DE-first per the i18n rule.
const DESKTOP_ONLY: Record<string, { category: string; access: 'public' | 'authenticated'; anonymous_safe: boolean; i18n: Record<Lang, Content> }> = {
  'DISCOVER.SHOP': {
    category: 'discover', access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Shop', description: 'The video-commerce shop — shoppable product videos from the Maxina marketplace.', when_to_visit: 'When the user asks to open the shop, the video shop, shoppable videos, or to browse products through video commerce.' },
      de: { title: 'Shop', description: 'Der Video-Commerce-Shop — shoppbare Produktvideos aus dem Maxina-Marktplatz.', when_to_visit: 'Wenn der Nutzer den Shop, den Video-Shop, shoppbare Videos öffnen oder Produkte über Video-Commerce durchstöbern möchte.' },
    },
  },
  'DISCOVER.MY_TICKETS': {
    category: 'discover', access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'My Tickets', description: 'The tickets you have purchased for events and meetups.', when_to_visit: 'When the user asks for their tickets, my tickets, event tickets, or the tickets they bought.' },
      de: { title: 'Meine Tickets', description: 'Die Tickets, die du für Events und Meetups gekauft hast.', when_to_visit: 'Wenn der Nutzer nach seinen Tickets, meinen Tickets, Event-Tickets oder den gekauften Tickets fragt.' },
    },
  },
  'COMM.MATCHES': {
    category: 'community', access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'People Who Match You', description: 'Members the matchmaker suggests you connect with, based on your goals and interests.', when_to_visit: 'When the user asks who matches them, their matches, suggested people, people to connect with, or the matchmaker results.' },
      de: { title: 'Passende Mitglieder', description: 'Mitglieder, die der Matchmaker dir basierend auf deinen Zielen und Interessen vorschlägt.', when_to_visit: 'Wenn der Nutzer fragt, wer zu ihm passt, nach seinen Matches, vorgeschlagenen Personen, Leuten zum Vernetzen oder den Matchmaker-Ergebnissen.' },
    },
  },
  'COMM.INVITE': {
    category: 'community', access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Invite Friends', description: 'Invite friends to join the Maxina community and earn rewards for referrals.', when_to_visit: 'When the user asks to invite friends, send an invite, share an invite link, or refer someone to Maxina.' },
      de: { title: 'Freunde einladen', description: 'Lade Freunde in die Maxina-Community ein und verdiene Belohnungen für Empfehlungen.', when_to_visit: 'Wenn der Nutzer Freunde einladen, eine Einladung senden, einen Einladungslink teilen oder jemanden zu Maxina empfehlen möchte.' },
    },
  },
  'SHARING.CAMPAIGN_DETAIL': {
    category: 'sharing', access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Campaign Detail', description: 'The detail view of a single sharing campaign — its reach, performance and content.', when_to_visit: 'When the user asks to open a specific sharing campaign, a campaign’s details, or the performance of one campaign.' },
      de: { title: 'Kampagnen-Detail', description: 'Die Detailansicht einer einzelnen Sharing-Kampagne — Reichweite, Performance und Inhalte.', when_to_visit: 'Wenn der Nutzer eine bestimmte Sharing-Kampagne, die Details einer Kampagne oder die Performance einer einzelnen Kampagne öffnen möchte.' },
    },
  },
};

const tsById = new Map(NAVIGATION_CATALOG.map((e) => [e.screen_id, e]));

function q(s: string): string {
  return (s ?? '').replace(/'/g, "''");
}

type Resolved = {
  screen_id: string; route: string; category: string;
  access: string; anonymous_safe: boolean; i18n: Record<string, Content>;
};

const resolved: Resolved[] = [];
const missing: string[] = [];
for (const [screen_id, route] of DESKTOP_ROUTES) {
  const only = DESKTOP_ONLY[screen_id];
  const ts = tsById.get(screen_id) as { category?: string; access?: string; anonymous_safe?: boolean; i18n?: Record<string, Content> } | undefined;
  if (only) {
    resolved.push({ screen_id, route, category: only.category, access: only.access, anonymous_safe: only.anonymous_safe, i18n: only.i18n });
  } else if (ts && ts.i18n && ts.i18n.en) {
    resolved.push({
      screen_id, route,
      category: ts.category as string,
      access: ts.access as string,
      anonymous_safe: !!ts.anonymous_safe,
      i18n: ts.i18n,
    });
  } else {
    missing.push(screen_id);
  }
}

if (missing.length) {
  // Fail loudly — never seed a screen with no title (ALWAYS rule #10).
  console.error('ERROR: no i18n found for desktop screens (add to DESKTOP_ONLY): ' + missing.join(', '));
  process.exit(1);
}

const out: string[] = [];
out.push('-- BOOTSTRAP-NAV-DESKTOP-CATALOG: the Desktop MAXINA navigation/routing catalog.');
out.push('-- Generated by services/gateway/scripts/gen-desktop-nav-seed.ts from the desktop');
out.push('-- web app route inventory (vitana-v1/src/App.tsx). Each entry reuses the screen’s');
out.push('-- category/access/i18n and overrides the route with the real desktop path,');
out.push('-- scoped to platform=\'desktop\'. Admin/dev/role-gated routes + redirects excluded.');
out.push('--');
out.push('-- impact-allow-solo-migration: pure data seed into the existing nav_catalog /');
out.push('-- nav_catalog_i18n tables (the runtime already reads them). Additive + idempotent.');
out.push(`-- ${resolved.length} desktop screens.`);
out.push('BEGIN;');
out.push('');

for (const e of resolved) {
  const langs = Object.keys(e.i18n);
  const i18nValues = langs
    .map((lang) => {
      const c = e.i18n[lang];
      return `    ('${q(lang)}', '${q(c.title)}', '${q(c.description)}', '${q(c.when_to_visit)}')`;
    })
    .join(',\n');

  out.push(`-- ${e.screen_id}`);
  out.push(`WITH up AS (`);
  out.push(`  INSERT INTO nav_catalog (screen_id, tenant_id, platform, route, category, access, anonymous_safe, priority, related_kb_topics, is_active)`);
  out.push(`  VALUES ('${q(e.screen_id)}', NULL, 'desktop', '${q(e.route)}', '${q(e.category)}', '${q(e.access)}', ${e.anonymous_safe ? 'TRUE' : 'FALSE'}, 0, '[]'::jsonb, TRUE)`);
  out.push(`  ON CONFLICT (screen_id, platform) WHERE tenant_id IS NULL`);
  out.push(`  DO UPDATE SET updated_at = now()`);
  out.push(`  RETURNING id`);
  out.push(`)`);
  out.push(`INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)`);
  out.push(`SELECT up.id, v.lang, v.title, v.description, v.wtv`);
  out.push(`FROM up CROSS JOIN (VALUES`);
  out.push(i18nValues);
  out.push(`) AS v(lang, title, description, wtv)`);
  out.push(`ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;`);
  out.push('');
}

out.push('COMMIT;');
process.stdout.write(out.join('\n') + '\n');
