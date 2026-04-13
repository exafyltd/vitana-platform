/**
 * Vitana Navigator — Navigation Catalog tests
 *
 * Two layers of coverage:
 *
 * 1. **Structural integrity** — every entry has a required English content
 *    block, screen_id is unique, route is unique, anonymous_safe matches
 *    access tier sanity rules.
 *
 * 2. **Routing quality** — sample utterances in EN and DE route to the
 *    expected screen_id via `searchCatalog`. This is the regression
 *    safety net for catalog edits — break a `when_to_visit` hint and
 *    the test catches it before Gemini gets confused in production.
 */

import {
  NAVIGATION_CATALOG,
  NavCatalogEntry,
  getContent,
  lookupScreen,
  suggestSimilar,
  searchCatalog,
  entriesByCategory,
} from '../src/lib/navigation-catalog';

// =============================================================================
// 1. Structural integrity
// =============================================================================

describe('navigation-catalog — structural integrity', () => {
  test('every entry has required English content', () => {
    for (const entry of NAVIGATION_CATALOG) {
      expect(entry.i18n.en).toBeDefined();
      expect(entry.i18n.en.title).toBeTruthy();
      expect(entry.i18n.en.description).toBeTruthy();
      expect(entry.i18n.en.when_to_visit).toBeTruthy();
    }
  });

  test('every entry has German content (Phase 1 commitment)', () => {
    for (const entry of NAVIGATION_CATALOG) {
      expect(entry.i18n.de).toBeDefined();
      expect(entry.i18n.de.title).toBeTruthy();
      expect(entry.i18n.de.description).toBeTruthy();
      expect(entry.i18n.de.when_to_visit).toBeTruthy();
    }
  });

  test('screen_ids are unique', () => {
    const seen = new Set<string>();
    for (const entry of NAVIGATION_CATALOG) {
      expect(seen.has(entry.screen_id)).toBe(false);
      seen.add(entry.screen_id);
    }
  });

  test('routes are unique', () => {
    const seen = new Set<string>();
    for (const entry of NAVIGATION_CATALOG) {
      expect(seen.has(entry.route)).toBe(false);
      seen.add(entry.route);
    }
  });

  test('routes start with /', () => {
    for (const entry of NAVIGATION_CATALOG) {
      expect(entry.route.startsWith('/')).toBe(true);
    }
  });

  test('access tier and anonymous_safe are consistent', () => {
    for (const entry of NAVIGATION_CATALOG) {
      // authenticated screens must NOT be anonymous_safe
      if (entry.access === 'authenticated') {
        expect(entry.anonymous_safe).toBe(false);
      }
      // public screens MAY be anonymous_safe (most are, but not required)
    }
  });

  test('catalog has at least one anonymous-safe entry per onboarding category', () => {
    // Anonymous users need somewhere to go: at minimum landing + signup portals
    const anonymousSafe = NAVIGATION_CATALOG.filter(e => e.anonymous_safe);
    expect(anonymousSafe.length).toBeGreaterThanOrEqual(3);
    expect(anonymousSafe.some(e => e.category === 'public')).toBe(true);
    expect(anonymousSafe.some(e => e.category === 'auth')).toBe(true);
  });

  test('priority screens cover Maxina growth focus (community + business + wallet)', () => {
    const priorityEntries = NAVIGATION_CATALOG.filter(e => (e.priority || 0) > 0);
    const priorityCategories = new Set(priorityEntries.map(e => e.category));
    expect(priorityCategories.has('community')).toBe(true);
    expect(priorityCategories.has('business')).toBe(true);
    expect(priorityCategories.has('wallet')).toBe(true);
  });
});

// =============================================================================
// 2. Lookup helpers
// =============================================================================

describe('navigation-catalog — lookup helpers', () => {
  test('lookupScreen returns the entry for a known id', () => {
    const entry = lookupScreen('COMM.EVENTS');
    expect(entry).not.toBeNull();
    expect(entry?.route).toBe('/comm/events-meetups');
  });

  test('lookupScreen returns null for unknown ids', () => {
    expect(lookupScreen('BOGUS.ID')).toBeNull();
    expect(lookupScreen('')).toBeNull();
  });

  test('suggestSimilar finds the right neighbor for a typo', () => {
    const suggestions = suggestSimilar('COMM.MEETUP');
    expect(suggestions.length).toBeGreaterThan(0);
    // COMM.EVENTS should be in the top suggestions (shares COMM prefix + meetup is in title/hint)
    const ids = suggestions.map(s => s.screen_id);
    expect(ids).toContain('COMM.EVENTS');
  });

  test('suggestSimilar handles fully unknown ids gracefully', () => {
    const suggestions = suggestSimilar('TOTALLY_UNRELATED');
    // returns an empty array or low-score matches, never throws
    expect(Array.isArray(suggestions)).toBe(true);
  });

  test('getContent falls back to English when language missing', () => {
    const entry = lookupScreen('COMM.EVENTS')!;
    const fr = getContent(entry, 'fr');
    expect(fr.title).toBe(entry.i18n.en.title); // falls back to English
  });

  test('getContent returns the localized version when present', () => {
    // Pick an entry whose DE title differs from its EN title
    const entry = lookupScreen('BUSINESS.SELL_EARN')!;
    const de = getContent(entry, 'de');
    expect(de.title).toBe(entry.i18n.de.title);
    expect(de.title).not.toBe(entry.i18n.en.title);
    // And the description should also be the German one
    expect(de.description).toBe(entry.i18n.de.description);
  });

  test('entriesByCategory filters correctly', () => {
    const business = entriesByCategory('business');
    expect(business.length).toBeGreaterThan(0);
    expect(business.every(e => e.category === 'business')).toBe(true);
  });
});

// =============================================================================
// 3. Routing quality (the load-bearing test)
// =============================================================================

interface RoutingCase {
  utterance: string;
  lang: string;
  expected_screen_id: string;
  description?: string;
}

const ROUTING_CASES: RoutingCase[] = [
  // ── COMM.EVENTS (P0) ──
  { utterance: 'take me to the events page',                lang: 'en', expected_screen_id: 'COMM.EVENTS' },
  { utterance: 'where can I find the meetups',              lang: 'en', expected_screen_id: 'COMM.EVENTS' },
  { utterance: 'show me upcoming events',                   lang: 'en', expected_screen_id: 'COMM.EVENTS' },
  { utterance: 'I want to attend a meetup',                 lang: 'en', expected_screen_id: 'COMM.EVENTS' },
  { utterance: 'wo finde ich die treffen',                  lang: 'de', expected_screen_id: 'COMM.EVENTS' },
  { utterance: 'zeig mir die kommenden veranstaltungen',    lang: 'de', expected_screen_id: 'COMM.EVENTS' },

  // ── COMM.LIVE_ROOMS ──
  { utterance: 'open the live rooms',                       lang: 'en', expected_screen_id: 'COMM.LIVE_ROOMS' },
  { utterance: 'I want to join a live room',                lang: 'en', expected_screen_id: 'COMM.LIVE_ROOMS' },
  { utterance: 'zeig mir die live räume',                   lang: 'de', expected_screen_id: 'COMM.LIVE_ROOMS' },

  // ── COMM.MEDIA_HUB ──
  { utterance: 'show me the videos and podcasts',           lang: 'en', expected_screen_id: 'COMM.MEDIA_HUB' },
  { utterance: 'wo sind die podcasts',                      lang: 'de', expected_screen_id: 'COMM.MEDIA_HUB' },

  // ── BUSINESS ──
  { utterance: 'I want to make money with the community',   lang: 'en', expected_screen_id: 'BUSINESS.SELL_EARN' },
  { utterance: 'how do I build a side income',              lang: 'en', expected_screen_id: 'BUSINESS.SELL_EARN' },
  { utterance: 'how can I monetize my fitness coaching',    lang: 'en', expected_screen_id: 'BUSINESS.SELL_EARN' },
  { utterance: 'I want to sell my services',                lang: 'en', expected_screen_id: 'BUSINESS.SELL_EARN' },
  { utterance: 'wie kann ich geld verdienen',               lang: 'de', expected_screen_id: 'BUSINESS.SELL_EARN' },
  { utterance: 'open my services',                          lang: 'en', expected_screen_id: 'BUSINESS.SERVICES' },
  { utterance: 'show me my clients',                        lang: 'en', expected_screen_id: 'BUSINESS.CLIENTS' },
  { utterance: 'wie laufen meine buchungen',                lang: 'de', expected_screen_id: 'BUSINESS.ANALYTICS' },

  // ── WALLET ──
  { utterance: 'open my wallet',                            lang: 'en', expected_screen_id: 'WALLET.OVERVIEW' },
  { utterance: 'what is in my wallet',                      lang: 'en', expected_screen_id: 'WALLET.OVERVIEW' },
  { utterance: 'show me my balance',                        lang: 'en', expected_screen_id: 'WALLET.BALANCE' },
  { utterance: 'how much have I earned in commissions',     lang: 'en', expected_screen_id: 'WALLET.REWARDS' },
  { utterance: 'show me my referral earnings',              lang: 'en', expected_screen_id: 'WALLET.REWARDS' },
  { utterance: 'meine provisionen anzeigen',                lang: 'de', expected_screen_id: 'WALLET.REWARDS' },
  { utterance: 'meine abonnements verwalten',               lang: 'de', expected_screen_id: 'WALLET.SUBSCRIPTIONS' },

  // ── HEALTH ──
  { utterance: 'how do I track my biology',                 lang: 'en', expected_screen_id: 'HEALTH.MY_BIOLOGY' },
  { utterance: 'show me my biomarkers',                     lang: 'en', expected_screen_id: 'HEALTH.MY_BIOLOGY' },
  { utterance: 'where are my lab results',                  lang: 'en', expected_screen_id: 'HEALTH.MY_BIOLOGY' },
  { utterance: 'meine biomarker zeigen',                    lang: 'de', expected_screen_id: 'HEALTH.MY_BIOLOGY' },
  { utterance: 'open my health plans',                      lang: 'en', expected_screen_id: 'HEALTH.PLANS' },
  { utterance: 'mein ernährungsplan',                       lang: 'de', expected_screen_id: 'HEALTH.PLANS' },

  // ── DISCOVER ──
  { utterance: 'show me supplements',                       lang: 'en', expected_screen_id: 'DISCOVER.SUPPLEMENTS' },
  { utterance: 'find me a doctor',                          lang: 'en', expected_screen_id: 'DISCOVER.DOCTORS_COACHES' },
  { utterance: 'I want to find a coach',                    lang: 'en', expected_screen_id: 'DISCOVER.DOCTORS_COACHES' },
  { utterance: 'are there any deals',                       lang: 'en', expected_screen_id: 'DISCOVER.DEALS' },

  // ── HOME ──
  { utterance: 'who matches me in the community',           lang: 'en', expected_screen_id: 'HOME.MATCHES' },
  { utterance: 'who should I meet',                         lang: 'en', expected_screen_id: 'HOME.MATCHES' },

  // ── MEMORY ──
  { utterance: 'open my daily diary',                       lang: 'en', expected_screen_id: 'MEMORY.DIARY' },
  { utterance: 'mein tagebuch öffnen',                      lang: 'de', expected_screen_id: 'MEMORY.DIARY' },

  // ── SETTINGS ──
  { utterance: 'open my privacy settings',                  lang: 'en', expected_screen_id: 'SETTINGS.PRIVACY' },
  { utterance: 'datenschutz einstellungen',                 lang: 'de', expected_screen_id: 'SETTINGS.PRIVACY' },
  { utterance: 'manage my notifications',                   lang: 'en', expected_screen_id: 'SETTINGS.NOTIFICATIONS' },

  // ── PUBLIC / AUTH ──
  { utterance: 'I want to register for the community',      lang: 'en', expected_screen_id: 'AUTH.MAXINA_PORTAL' },
  { utterance: 'how do I sign up for maxina',               lang: 'en', expected_screen_id: 'AUTH.MAXINA_PORTAL' },
  { utterance: 'ich möchte mich registrieren',              lang: 'de', expected_screen_id: 'AUTH.MAXINA_PORTAL' },

  // ── PHASE 2: FULL COVERAGE EXPANSION ──────────────────────────────────

  // ── HOME expanded ──
  { utterance: 'show me my pending actions',                  lang: 'en', expected_screen_id: 'HOME.ACTIONS' },
  { utterance: 'what tasks are pending for me',              lang: 'en', expected_screen_id: 'HOME.ACTIONS' },
  { utterance: 'show me my context',                         lang: 'en', expected_screen_id: 'HOME.CONTEXT' },

  // ── AI expanded ──
  { utterance: 'open the AI assistant',                      lang: 'en', expected_screen_id: 'AI.OVERVIEW' },
  { utterance: 'show me AI insights',                        lang: 'en', expected_screen_id: 'AI.INSIGHTS' },
  { utterance: 'zeig mir KI einblicke',                      lang: 'de', expected_screen_id: 'AI.INSIGHTS' },
  { utterance: 'open my daily summary',                      lang: 'en', expected_screen_id: 'AI.DAILY_SUMMARY' },
  { utterance: 'tägliche zusammenfassung',                   lang: 'de', expected_screen_id: 'AI.DAILY_SUMMARY' },

  // ── DISCOVER expanded ──
  { utterance: 'show me my orders',                          lang: 'en', expected_screen_id: 'DISCOVER.ORDERS' },
  { utterance: 'meine bestellungen',                         lang: 'de', expected_screen_id: 'DISCOVER.ORDERS' },
  { utterance: 'show me AI picks',                           lang: 'en', expected_screen_id: 'DISCOVER.AI_PICKS' },

  // ── INBOX expanded ──
  { utterance: 'show me inspiration messages',               lang: 'en', expected_screen_id: 'INBOX.INSPIRATION' },
  { utterance: 'open archived messages',                     lang: 'en', expected_screen_id: 'INBOX.ARCHIVED' },
  { utterance: 'archivierte nachrichten',                    lang: 'de', expected_screen_id: 'INBOX.ARCHIVED' },

  // ── SHARING (entire new section) ──
  { utterance: 'open sharing',                               lang: 'en', expected_screen_id: 'SHARING.OVERVIEW' },
  { utterance: 'open the sharing referrals section',          lang: 'en', expected_screen_id: 'SHARING.OVERVIEW' },
  { utterance: 'freunde einladen',                           lang: 'de', expected_screen_id: 'SHARING.OVERVIEW' },
  { utterance: 'show my sharing campaigns',                  lang: 'en', expected_screen_id: 'SHARING.CAMPAIGNS' },
  { utterance: 'open distribution',                          lang: 'en', expected_screen_id: 'SHARING.DISTRIBUTION' },
  { utterance: 'data consent settings',                      lang: 'en', expected_screen_id: 'SHARING.DATA_CONSENT' },
  { utterance: 'daten einwilligung',                         lang: 'de', expected_screen_id: 'SHARING.DATA_CONSENT' },

  // ── MEMORY expanded ──
  { utterance: 'open my timeline',                           lang: 'en', expected_screen_id: 'MEMORY.TIMELINE' },
  { utterance: 'zeig mir die zeitleiste',                    lang: 'de', expected_screen_id: 'MEMORY.TIMELINE' },
  { utterance: 'search my memories',                         lang: 'en', expected_screen_id: 'MEMORY.RECALL' },
  { utterance: 'erinnerungen durchsuchen',                   lang: 'de', expected_screen_id: 'MEMORY.RECALL' },
  { utterance: 'memory permissions',                         lang: 'en', expected_screen_id: 'MEMORY.PERMISSIONS' },

  // ── SETTINGS expanded ──
  { utterance: 'customize my app preferences',               lang: 'en', expected_screen_id: 'SETTINGS.PREFERENCES' },
  { utterance: 'connected apps settings',                    lang: 'en', expected_screen_id: 'SETTINGS.CONNECTED_APPS' },
  { utterance: 'social accounts settings',                   lang: 'en', expected_screen_id: 'SETTINGS.SOCIAL' },
  { utterance: 'open billing',                               lang: 'en', expected_screen_id: 'SETTINGS.BILLING' },
  { utterance: 'abrechnung öffnen',                          lang: 'de', expected_screen_id: 'SETTINGS.BILLING' },
  { utterance: 'I need help from support',                   lang: 'en', expected_screen_id: 'SETTINGS.SUPPORT' },
  { utterance: 'hilfe und support',                          lang: 'de', expected_screen_id: 'SETTINGS.SUPPORT' },

  // ── HEALTH expanded ──
  { utterance: 'show me the health pillars',                 lang: 'en', expected_screen_id: 'HEALTH.PILLARS' },
  { utterance: 'gesundheitssäulen anzeigen',                 lang: 'de', expected_screen_id: 'HEALTH.PILLARS' },
  { utterance: 'show my health conditions',                  lang: 'en', expected_screen_id: 'HEALTH.CONDITIONS' },

  // ── PUBLIC expanded ──
  { utterance: 'show me the terms of use',                   lang: 'en', expected_screen_id: 'PUBLIC.TERMS' },
  { utterance: 'nutzungsbedingungen',                        lang: 'de', expected_screen_id: 'PUBLIC.TERMS' },

  // ── PROFILE ──
  { utterance: 'open my profile',                            lang: 'en', expected_screen_id: 'PROFILE.ME' },
  { utterance: 'show me my profile',                         lang: 'en', expected_screen_id: 'PROFILE.ME' },
  { utterance: 'mein profil öffnen',                         lang: 'de', expected_screen_id: 'PROFILE.ME' },

  // ── INBOX with chat keywords ──
  { utterance: 'open my chat history',                       lang: 'en', expected_screen_id: 'INBOX.OVERVIEW' },
  { utterance: 'show my message history and conversations',   lang: 'en', expected_screen_id: 'INBOX.OVERVIEW' },
  { utterance: 'öffne meinen chat verlauf',                  lang: 'de', expected_screen_id: 'INBOX.OVERVIEW' },
];

describe('navigation-catalog — routing quality', () => {
  test.each(ROUTING_CASES)(
    '"$utterance" ($lang) → $expected_screen_id',
    ({ utterance, lang, expected_screen_id }) => {
      const results = searchCatalog(utterance, lang);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.screen_id).toBe(expected_screen_id);
    }
  );

  test('searchCatalog returns empty for empty query', () => {
    expect(searchCatalog('', 'en')).toEqual([]);
    expect(searchCatalog('   ', 'en')).toEqual([]);
  });

  test('searchCatalog excludes routes from exclude_routes', () => {
    // user is already on /comm/events-meetups — searching events should NOT return it
    const results = searchCatalog('events meetups', 'en', {
      exclude_routes: ['/comm/events-meetups'],
    });
    const ids = results.map(r => r.entry.screen_id);
    expect(ids).not.toContain('COMM.EVENTS');
  });

  test('searchCatalog with anonymous_only filter excludes authenticated screens', () => {
    const results = searchCatalog('events', 'en', { anonymous_only: true });
    for (const r of results) {
      expect(r.entry.anonymous_safe).toBe(true);
    }
  });

  test('priority boost favors promoted destinations on ambiguous queries', () => {
    // "I want to join the community" should rank an auth/community priority entry highly
    const results = searchCatalog('I want to join the community', 'en');
    expect(results.length).toBeGreaterThan(0);
    // The top result should be one of the priority-boosted screens
    const topPriority = results[0].entry.priority || 0;
    // Just verify priority entries appear in top 5
    const top5Priorities = results.slice(0, 5).map(r => r.entry.priority || 0);
    expect(Math.max(...top5Priorities)).toBeGreaterThan(0);
  });
});
