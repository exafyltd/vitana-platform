/**
 * VTID-04607 — the voice redirect suite: 50 things members say when they
 * want Vitana to open a screen, and the screen that must open.
 *
 * Every case runs three ways (see README.md in this folder):
 *   - in CI, through the real `navigate` tool with the bundled registry
 *     snapshot and its stored Titan vectors (nav-redirect-suite.test.ts);
 *   - live, against the registry a deployment serves, with real Titan;
 *   - live, spoken to Nova Sonic, which must call the tool itself.
 *
 * Writing a case:
 *   - Say it the way a member would, not the way the registry phrases it.
 *     A registry phrasing copied here proves nothing about the next member.
 *   - `expect` lists every screen that is a correct answer, best first. A
 *     page and its own tab can both be right ("my orders" → Orders or
 *     Active Orders); two different pages rarely are.
 *   - Only screens a voice request can open: not disabled, no entity id.
 *   - Ids are checked against the registry snapshot, so a renamed or
 *     removed screen fails the suite until the case is updated.
 *
 * When you add a screen or a popup a member will ask for by name, add a
 * case for it here and re-run build-embeddings (README.md).
 */

export type RedirectLang = 'en' | 'de' | 'es' | 'fr' | 'sr' | 'pt' | 'pl' | 'ar' | 'ru' | 'tr' | 'zh';

export interface RedirectCase {
  id: string;
  lang: RedirectLang;
  /** What the member says. */
  say: string;
  /** Screens that are a correct answer, best first. */
  expect: string[];
  /** Device the member is on; desktop when omitted. */
  viewport?: 'mobile' | 'desktop';
}

export const REDIRECT_CASES: RedirectCase[] = [
  // Wallet and money
  { id: 'R01', lang: 'en', say: 'Take me to my wallet', expect: ['WALLET.OVERVIEW'] },
  { id: 'R02', lang: 'en', say: 'Show me my rewards', expect: ['WALLET.REWARDS'] },
  { id: 'R03', lang: 'en', say: 'Open my subscriptions', expect: ['WALLET.SUBSCRIPTIONS'] },
  { id: 'R04', lang: 'en', say: 'Pop up my wallet quickly, I just want a quick look', expect: ['OVERLAY.WALLET_POPUP'] },
  { id: 'R05', lang: 'en', say: 'Open my billing settings', expect: ['SETTINGS.BILLING'] },

  // Messages, calendar, reminders, profile
  { id: 'R06', lang: 'en', say: 'Open my inbox', expect: ['INBOX.OVERVIEW'] },
  { id: 'R07', lang: 'en', say: 'Show me my messages', expect: ['INBOX.OVERVIEW'] },
  { id: 'R08', lang: 'en', say: 'Open my calendar', expect: ['CALENDAR.OVERVIEW'] },
  { id: 'R09', lang: 'en', say: 'Open my reminders', expect: ['REMINDERS.OVERVIEW'] },
  { id: 'R10', lang: 'en', say: 'Go to my profile', expect: ['PROFILE.ME'] },

  // Memory and diary
  { id: 'R11', lang: 'en', say: 'Show me my diary', expect: ['MEMORY.DIARY', 'MEMORY.DAILY_DIARY'] },
  { id: 'R12', lang: 'en', say: 'Open my diary', expect: ['MEMORY.DIARY', 'MEMORY.DAILY_DIARY'], viewport: 'mobile' },
  { id: 'R13', lang: 'en', say: 'Take me to my memory garden', expect: ['MEMORY.OVERVIEW'] },

  // Settings
  { id: 'R14', lang: 'en', say: 'Open settings', expect: ['SETTINGS.OVERVIEW'] },
  { id: 'R15', lang: 'en', say: 'Take me to the notification settings', expect: ['SETTINGS.NOTIFICATIONS'] },
  { id: 'R16', lang: 'en', say: 'Open the settings where I change the app language', expect: ['SETTINGS.PREFERENCES_LANGUAGE'] },
  { id: 'R17', lang: 'en', say: 'Open the settings for dark mode', expect: ['SETTINGS.PREFERENCES_APPEARANCE'] },
  { id: 'R18', lang: 'en', say: 'Open my privacy settings', expect: ['SETTINGS.PRIVACY'] },
  { id: 'R19', lang: 'en', say: 'Show me my connected apps', expect: ['SETTINGS.CONNECTED_APPS'] },
  { id: 'R20', lang: 'en', say: 'I need help, take me to support', expect: ['SETTINGS.SUPPORT', 'SETTINGS.SUPPORT_CONTACT'] },

  // Community
  { id: 'R21', lang: 'en', say: "Show me today's events", expect: ['COMM.EVENTS_TODAY'] },
  { id: 'R22', lang: 'en', say: 'Take me to the live rooms', expect: ['COMM.LIVE_ROOMS', 'COMM.LIVE_ROOMS_ALL'] },
  { id: 'R23', lang: 'en', say: 'Show me the groups', expect: ['COMM.GROUPS'] },
  { id: 'R24', lang: 'en', say: 'Open the podcasts', expect: ['COMM.MEDIA_PODCASTS', 'HEALTH.EDUCATION_PODCASTS'] },
  { id: 'R25', lang: 'en', say: 'I want to invite a friend to the app', expect: ['COMM.INVITE'] },

  // Health
  { id: 'R26', lang: 'en', say: 'Show me my Vitana Index', expect: ['HEALTH.VITANA_INDEX', 'OVERLAY.VITANA_INDEX'] },
  { id: 'R27', lang: 'en', say: 'Open my sleep plan', expect: ['HEALTH.PLANS_SLEEP'] },
  { id: 'R28', lang: 'en', say: 'Show me my workout plans', expect: ['HEALTH.PLANS_EXERCISE'] },
  { id: 'R29', lang: 'en', say: 'Open my life compass', expect: ['LIFE_COMPASS.OVERLAY'] },

  // Discover and shopping
  { id: 'R30', lang: 'en', say: 'Open the marketplace', expect: ['DISCOVER.MARKETPLACE'] },
  { id: 'R31', lang: 'en', say: 'Show me my shopping cart', expect: ['DISCOVER.CART'] },
  { id: 'R32', lang: 'en', say: 'Show me my orders', expect: ['DISCOVER.ORDERS', 'DISCOVER.ORDERS_ACTIVE'] },
  { id: 'R33', lang: 'en', say: 'Take me to the supplements', expect: ['DISCOVER.SUPPLEMENTS'] },
  { id: 'R34', lang: 'en', say: 'Find me doctors and coaches', expect: ['DISCOVER.DOCTORS_COACHES'] },
  { id: 'R35', lang: 'en', say: 'Open the business hub', expect: ['BUSINESS.OVERVIEW'] },

  // German — the community's main language
  { id: 'R36', lang: 'de', say: 'Öffne meinen Kalender', expect: ['CALENDAR.OVERVIEW'] },
  { id: 'R37', lang: 'de', say: 'Zeig mir mein Profil', expect: ['PROFILE.ME'] },
  { id: 'R38', lang: 'de', say: 'Bring mich zu meinen Nachrichten', expect: ['INBOX.OVERVIEW'] },
  { id: 'R39', lang: 'de', say: 'Öffne mein Tagebuch', expect: ['MEMORY.DIARY', 'MEMORY.DAILY_DIARY'] },
  { id: 'R40', lang: 'de', say: 'Zeig mir meine Wallet', expect: ['WALLET.OVERVIEW'] },
  { id: 'R41', lang: 'de', say: 'Öffne die Einstellungen', expect: ['SETTINGS.OVERVIEW'] },
  { id: 'R42', lang: 'de', say: 'Zeig mir die Veranstaltungen von heute', expect: ['COMM.EVENTS_TODAY'] },
  { id: 'R43', lang: 'de', say: 'Öffne meinen Schlafplan', expect: ['HEALTH.PLANS_SLEEP'] },
  { id: 'R44', lang: 'de', say: 'Bring mich zum Marktplatz', expect: ['DISCOVER.MARKETPLACE'] },
  { id: 'R45', lang: 'de', say: 'Ich möchte meine Benachrichtigungen einstellen, öffne das bitte', expect: ['SETTINGS.NOTIFICATIONS'] },

  // Other shipped languages
  { id: 'R46', lang: 'es', say: 'Abre mi calendario', expect: ['CALENDAR.OVERVIEW'] },
  { id: 'R47', lang: 'fr', say: 'Ouvre mes messages', expect: ['INBOX.OVERVIEW'] },
  { id: 'R48', lang: 'sr', say: 'Otvori moj profil', expect: ['PROFILE.ME'] },
  { id: 'R49', lang: 'pt', say: 'Abre as minhas recompensas', expect: ['WALLET.REWARDS'] },
  { id: 'R50', lang: 'ar', say: 'افتح الإعدادات', expect: ['SETTINGS.OVERVIEW'] },
];

/**
 * The voice model does not always pass the member's words to `navigate`: it
 * shortens them. These are paraphrases Nova Sonic actually sent during the
 * live voice run (VTID-04607). With the member's transcript passed along,
 * the resolver must still land on the screen the member asked for.
 */
export interface ParaphraseCase {
  id: string;
  lang: RedirectLang;
  /** What the member said (the session transcript). */
  say: string;
  /** What the voice model passed as `question`. */
  modelQuestion: string;
  expect: string[];
}

export const PARAPHRASE_CASES: ParaphraseCase[] = [
  { id: 'P01', lang: 'en', say: 'Pop up my wallet quickly, I just want a quick look', modelQuestion: 'wallet', expect: ['OVERLAY.WALLET_POPUP'] },
  { id: 'P02', lang: 'en', say: 'Show me my rewards', modelQuestion: 'rewards', expect: ['WALLET.REWARDS'] },
  { id: 'P03', lang: 'en', say: 'Show me my orders', modelQuestion: 'orders', expect: ['DISCOVER.ORDERS', 'DISCOVER.ORDERS_ACTIVE'] },
  // A bare yes carries no screen: the model's question must decide.
  { id: 'P04', lang: 'en', say: 'Yes please, open it', modelQuestion: 'my blood test results', expect: ['HEALTH.MY_BIOLOGY'] },
];
