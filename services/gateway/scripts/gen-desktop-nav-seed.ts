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

// Per-page DESKTOP tab/section deep-links — ONLY the tabs that are actually
// URL-addressable on desktop (verified against the page components; state-only
// <SplitBar> tabs are excluded because they have no address to navigate to).
// Generated into their own migration via `--tabs-only`.
const DESKTOP_TAB_ROUTES: Array<[string, string]> = [
  // Events & Meetups (?tab=)
  ['COMM.EVENTS_HOT', '/comm/events-meetups?tab=hot'],
  ['COMM.EVENTS_UPCOMING', '/comm/events-meetups?tab=upcoming'],
  ['COMM.EVENTS_TODAY', '/comm/events-meetups?tab=today'],
  ['COMM.FEED', '/comm/events-meetups?tab=following'],
  // Live Rooms (?tab=)
  ['COMM.LIVE_ROOMS_ALL', '/comm/live-rooms?tab=all'],
  ['COMM.LIVE_ROOMS_LIVE', '/comm/live-rooms?tab=live'],
  ['COMM.LIVE_ROOMS_SCHEDULED', '/comm/live-rooms?tab=scheduled'],
  ['COMM.LIVE_ROOMS_PAST', '/comm/live-rooms?tab=past'],
  // Media Hub (?tab=)
  ['COMM.MEDIA_SHORTS', '/comm/media-hub?tab=shorts'],
  ['COMM.MEDIA_MUSIC', '/comm/media-hub?tab=music'],
  ['COMM.MEDIA_PODCASTS', '/comm/media-hub?tab=podcasts'],
  // Discover index (?tab=) — 'suggested' is covered by the /discover/ai-picks page
  ['DISCOVER.CATEGORIES', '/discover?tab=categories'],
  ['DISCOVER.SHARE_EARN', '/discover?tab=share'],
  // Marketplace (?view=) — desktop-specific
  ['DISCOVER.MARKETPLACE_OPEN', '/discover/marketplace?view=open'],
  ['DISCOVER.MARKETPLACE_MINE', '/discover/marketplace?view=mine'],
  // Home news (?tab=) — 'longevity' is the default (= HOME.OVERVIEW)
  ['HOME.NEWS_ALL', '/home?tab=all'],
  ['HOME.NEWS_COMMUNITY', '/home?tab=community'],
  // Assistant (?tab=) — desktop-specific
  ['ASSISTANT.VOICE', '/assistant?tab=voice'],
  ['ASSISTANT.AI', '/assistant?tab=ai'],
  ['ASSISTANT.AUTOPILOT', '/assistant?tab=autopilot'],
  ['ASSISTANT.PROACTIVE', '/assistant?tab=proactive'],
  ['ASSISTANT.REFERRALS', '/assistant?tab=referrals'],
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
  // Desktop-specific tabs (no mobile pill to reuse).
  'DISCOVER.MARKETPLACE_OPEN': {
    category: 'discover', access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Open Requests', description: 'The Open view of the marketplace — requests and offers open to everyone.', when_to_visit: 'When the user asks for the Open tab of the marketplace, open marketplace requests, or offers open to all.' },
      de: { title: 'Offene Anfragen', description: 'Die Ansicht „Offen“ des Marktplatzes — Anfragen und Angebote, die allen offenstehen.', when_to_visit: 'Wenn der Nutzer nach dem Tab „Offen“ des Marktplatzes, offenen Marktplatz-Anfragen oder allgemein offenen Angeboten fragt.' },
    },
  },
  'DISCOVER.MARKETPLACE_MINE': {
    category: 'discover', access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'My Marketplace', description: 'The Mine view of the marketplace — your own requests, offers and listings.', when_to_visit: 'When the user asks for the Mine tab of the marketplace, their own marketplace requests, offers, or listings.' },
      de: { title: 'Mein Marktplatz', description: 'Die Ansicht „Meine“ des Marktplatzes — deine eigenen Anfragen, Angebote und Inserate.', when_to_visit: 'Wenn der Nutzer nach dem Tab „Meine“ des Marktplatzes, seinen eigenen Marktplatz-Anfragen, Angeboten oder Inseraten fragt.' },
    },
  },
  'ASSISTANT.VOICE': {
    category: 'ai', access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Voice', description: 'The Voice tab of the AI Assistant — voice settings and your voice-first ORB experience.', when_to_visit: 'When the user asks for the Voice tab of the Assistant, voice settings, voice AI, or to configure the voice assistant.' },
      de: { title: 'Stimme', description: 'Der Voice-Tab des KI-Assistenten — Spracheinstellungen und dein Voice-First-ORB-Erlebnis.', when_to_visit: 'Wenn der Nutzer nach dem Voice-Tab des Assistenten, Spracheinstellungen, Voice-KI fragt oder den Sprachassistenten konfigurieren möchte.' },
    },
  },
  'ASSISTANT.AI': {
    category: 'ai', access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'AI', description: 'The AI tab of the Assistant — your text AI assistant and its settings.', when_to_visit: 'When the user asks for the AI tab of the Assistant, the text assistant, or AI assistant settings.' },
      de: { title: 'KI', description: 'Der KI-Tab des Assistenten — dein Text-KI-Assistent und seine Einstellungen.', when_to_visit: 'Wenn der Nutzer nach dem KI-Tab des Assistenten, dem Text-Assistenten oder den KI-Assistenten-Einstellungen fragt.' },
    },
  },
  'ASSISTANT.AUTOPILOT': {
    category: 'ai', access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Autopilot & Automation', description: 'The Autopilot tab of the Assistant — automations Vitana runs on your behalf.', when_to_visit: 'When the user asks for the Autopilot tab of the Assistant, automation settings, or what Vitana automates for them.' },
      de: { title: 'Autopilot & Automatisierung', description: 'Der Autopilot-Tab des Assistenten — Automatisierungen, die Vitana für dich ausführt.', when_to_visit: 'Wenn der Nutzer nach dem Autopilot-Tab des Assistenten, Automatisierungseinstellungen oder dem fragt, was Vitana für ihn automatisiert.' },
    },
  },
  'ASSISTANT.PROACTIVE': {
    category: 'ai', access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Proactive Talking', description: 'The Proactive tab of the Assistant — control when Vitana speaks up unprompted.', when_to_visit: 'When the user asks for the Proactive tab of the Assistant, proactive talking, or when Vitana should reach out unprompted.' },
      de: { title: 'Proaktives Sprechen', description: 'Der Proaktiv-Tab des Assistenten — steuere, wann Vitana von sich aus spricht.', when_to_visit: 'Wenn der Nutzer nach dem Proaktiv-Tab des Assistenten, proaktivem Sprechen oder dem fragt, wann Vitana sich von selbst melden soll.' },
    },
  },
  'ASSISTANT.REFERRALS': {
    category: 'ai', access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Referrals', description: 'The Referrals tab of the Assistant — referrals and rewards from the assistant.', when_to_visit: 'When the user asks for the Referrals tab of the Assistant, assistant referrals, or referral rewards in the Assistant.' },
      de: { title: 'Empfehlungen', description: 'Der Empfehlungen-Tab des Assistenten — Empfehlungen und Belohnungen aus dem Assistenten.', when_to_visit: 'Wenn der Nutzer nach dem Empfehlungen-Tab des Assistenten, Assistenten-Empfehlungen oder Empfehlungsbelohnungen im Assistenten fragt.' },
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

const TABS_ONLY = process.argv.includes('--tabs-only');
const SOURCE = TABS_ONLY ? DESKTOP_TAB_ROUTES : DESKTOP_ROUTES;

const resolved: Resolved[] = [];
const missing: string[] = [];
for (const [screen_id, route] of SOURCE) {
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
out.push(TABS_ONLY
  ? '-- BOOTSTRAP-NAV-DESKTOP-TABS: per-page tab/section deep-links for Desktop MAXINA.'
  : '-- BOOTSTRAP-NAV-DESKTOP-CATALOG: the Desktop MAXINA navigation/routing catalog.');
out.push('-- Generated by services/gateway/scripts/gen-desktop-nav-seed.ts from the desktop');
out.push('-- web app inventory (vitana-v1/src/App.tsx + page components). Each entry reuses');
out.push('-- the screen’s category/access/i18n and overrides the route with the real desktop');
out.push('-- path, scoped to platform=\'desktop\'. Tabs included here are ONLY the ones that are');
out.push('-- actually URL-addressable on desktop (state-only <SplitBar> tabs are excluded).');
out.push('--');
out.push('-- impact-allow-solo-migration: pure data seed into the existing nav_catalog /');
out.push('-- nav_catalog_i18n tables (the runtime already reads them). Additive + idempotent.');
out.push(`-- ${resolved.length} desktop ${TABS_ONLY ? 'tab deep-links' : 'screens'}.`);
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
