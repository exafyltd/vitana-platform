/**
 * VTID-04496 — Navigation rebuild, Phase 0: the golden utterance set.
 *
 * The measuring stick for the ORB user-navigation rebuild. Every case is one
 * thing a real member could say to Vitana, the screen(s) that would answer it,
 * and what Vitana should DO about it under the owner-approved policy:
 *
 *   intent 'open'  — an explicit command ("open / show / take me to X").
 *                    Correct behaviour: open the screen straight away.
 *   intent 'where' — a question about where information lives ("where can I
 *                    see X?", "how do I find X?"). Correct behaviour: say where
 *                    it is, then OFFER to open it; open only after a "yes".
 *   intent 'none'  — not a navigation request at all. Correct behaviour:
 *                    no redirect and no offer.
 *
 * `expect` lists every screen that is an acceptable answer (a tab of the right
 * page is usually fine; the case says so explicitly). `forbid` lists screens
 * that must never win — wrong-family guards and every wrong screen production
 * has actually sent someone to.
 *
 * Sources:
 *   'prod'        — a phrasing observed in oasis_events orb.navigator.* in
 *                   September 2026 (the failure it caused is noted on the case).
 *   'handwritten' — written for this set; held out from any future registry
 *                   example-phrasing list so the resolver cannot be tuned to it.
 *
 * Screen ids are the current catalog ids (services/gateway/src/lib/
 * navigation-catalog.ts). The Phase 1 registry keeps these ids, so this set
 * carries over unchanged; `golden-set.integrity.test.ts` fails if a case ever
 * names an id the catalog does not have.
 *
 * Adding a screen or moving content to a different screen: add or update the
 * cases here in the same PR. That is the regression contract.
 */

export type GoldenLang = 'en' | 'de' | 'es' | 'fr' | 'sr' | 'pl' | 'pt' | 'ru' | 'tr' | 'ar' | 'zh';

export type GoldenIntent = 'open' | 'where' | 'none';

export interface GoldenCase {
  /** Stable id: <screen-or-topic>.<lang>.<n>. Never reuse a retired id. */
  id: string;
  lang: GoldenLang;
  utterance: string;
  intent: GoldenIntent;
  /** Acceptable screens. Empty for intent 'none'. */
  expect: string[];
  /** Screens that must never be chosen for this utterance. */
  forbid?: string[];
  platform?: 'mobile' | 'desktop';
  source: 'prod' | 'handwritten';
  note?: string;
}

const NEWS = ['HOME.OVERVIEW', 'HOME.NEWS_ALL'];
const EVENTS = ['COMM.EVENTS', 'COMM.EVENTS_UPCOMING', 'COMM.EVENTS_TODAY', 'COMM.EVENTS_HOT'];
const INDEX = ['HEALTH.VITANA_INDEX', 'OVERLAY.VITANA_INDEX'];
const INBOX = ['INBOX.OVERVIEW', 'MESSAGES.OVERVIEW'];
const DIARY = ['MEMORY.DIARY', 'MEMORY.DAILY_DIARY'];
const MATCHES = ['HOME.MATCHES', 'COMM.FIND_PARTNER_MATCHES'];
const LIVE = ['COMM.LIVE_ROOMS', 'COMM.LIVE_ROOMS_LIVE', 'COMM.LIVE_ROOMS_ALL'];
const REMINDERS = ['REMINDERS.OVERVIEW', 'INBOX.REMINDERS'];
const SUPPORT = ['SETTINGS.SUPPORT', 'SETTINGS.SUPPORT_CONTACT', 'SETTINGS.SUPPORT_FAQ'];
const WALLET = ['WALLET.OVERVIEW', 'WALLET.BALANCE', 'OVERLAY.WALLET_POPUP'];
const ORDERS = ['DISCOVER.ORDERS', 'DISCOVER.ORDERS_ACTIVE', 'DISCOVER.ORDERS_HISTORY'];
const SUPPLEMENTS_SHOP = ['DISCOVER.SUPPLEMENTS'];
const COMMERCE_WRONG = ['DISCOVER.CART', 'DISCOVER.MARKETPLACE', 'DISCOVER.ORDERS'];

type Row = [GoldenLang, GoldenIntent, string, string?];

/** Expand a table of phrasings for one destination into cases. */
function screen(
  key: string,
  expect: string[],
  rows: Row[],
  extra: { forbid?: string[]; platform?: 'mobile' | 'desktop'; source?: 'prod' | 'handwritten' } = {},
): GoldenCase[] {
  const counters: Record<string, number> = {};
  return rows.map(([lang, intent, utterance, note]) => {
    counters[lang] = (counters[lang] || 0) + 1;
    return {
      id: `${key}.${lang}.${counters[lang]}`,
      lang,
      utterance,
      intent,
      expect,
      forbid: extra.forbid,
      platform: extra.platform,
      source: extra.source || 'handwritten',
      note,
    };
  });
}

export const GOLDEN_SET: GoldenCase[] = [
  // ── Production failures (September 2026) ────────────────────────────────
  {
    id: 'prod.news-to-cart.sr.1', lang: 'sr', utterance: 'najnovije vesti otvori ekran', intent: 'open',
    expect: NEWS, forbid: COMMERCE_WRONG, source: 'prod',
    note: '2026-09-18: resolved confident/high to DISCOVER.CART and the app went to the cart.',
  },
  {
    id: 'prod.news-unknown.sr.1', lang: 'sr', utterance: 'najnovije vesti', intent: 'where',
    expect: NEWS, forbid: COMMERCE_WRONG, source: 'prod',
    note: '2026-09-18: decision unknown, no match.',
  },
  {
    id: 'prod.all-news.en.1', lang: 'en', utterance: 'open all news', intent: 'open',
    expect: ['HOME.NEWS_ALL', 'HOME.OVERVIEW'], forbid: ['NEWS.DETAIL'], source: 'prod',
    note: '2026-09-18: exact screen title judged ambiguous; NEWS.DETAIL (needs an article id) offered as a candidate.',
  },
  {
    id: 'prod.news-feed.en.1', lang: 'en', utterance: 'open the news feed all news', intent: 'open',
    expect: ['HOME.NEWS_ALL', 'HOME.OVERVIEW'], forbid: ['NEWS.DETAIL'], source: 'prod',
  },
  {
    id: 'prod.news-screen.en.1', lang: 'en', utterance: 'news screen news feed', intent: 'open',
    expect: NEWS, forbid: ['NEWS.DETAIL'], source: 'prod',
  },
  {
    id: 'prod.community-news.en.1', lang: 'en', utterance: 'open community news', intent: 'open',
    expect: ['HOME.NEWS_COMMUNITY'], source: 'prod',
    note: '2026-09-18: refused as already_there when asked from /home.',
  },
  {
    id: 'prod.my-journeys.en.1', lang: 'en', utterance: 'take me to my journeys screen', intent: 'open',
    expect: ['AUTOPILOT.MY_JOURNEY'], source: 'prod',
    note: '2026-09-18: decision unknown although the primary was correct.',
  },
  {
    id: 'prod.vitana-index.sr.1', lang: 'sr', utterance: 'Vitana indeks', intent: 'open',
    expect: INDEX, forbid: ['ASSISTANT.OVERVIEW'], source: 'prod',
    note: '2026-09-18: ambiguous between the index page, the index sheet and Vitana Chat.',
  },
  { id: 'prod.inbox.en.1', lang: 'en', utterance: 'open inbox', intent: 'open', expect: INBOX, source: 'prod' },
  { id: 'prod.media-hub.en.1', lang: 'en', utterance: 'media hub', intent: 'open', expect: ['COMM.MEDIA_HUB'], source: 'prod' },

  // ── News ────────────────────────────────────────────────────────────────
  ...screen('news', NEWS, [
    ['en', 'open', 'Show me the latest news'],
    ['en', 'where', 'Where can I read the longevity news?'],
    ['de', 'open', 'Zeig mir die neuesten Longevity-News'],
    ['de', 'where', 'Wo finde ich die Neuigkeiten?'],
    ['es', 'open', 'Muéstrame las últimas noticias'],
    ['fr', 'open', 'Montre-moi les dernières actualités'],
    ['sr', 'open', 'Pokaži mi najnovije vesti'],
    ['pl', 'open', 'Pokaż mi najnowsze wiadomości o długowieczności'],
    ['pt', 'open', 'Mostra-me as últimas notícias'],
    ['ru', 'open', 'Покажи последние новости'],
    ['tr', 'open', 'Bana son haberleri göster'],
    ['ar', 'open', 'اعرض لي آخر الأخبار'],
    ['zh', 'open', '给我看最新的新闻'],
  ], { forbid: [...COMMERCE_WRONG, ...INBOX, 'NEWS.DETAIL'] }),

  // German "Nachrichten" is both news and messages; in a messaging phrasing
  // it means messages.
  ...screen('messages', INBOX, [
    ['en', 'open', 'Open my messages'],
    ['en', 'where', 'Where can I see my messages?'],
    ['de', 'open', 'Öffne meine Nachrichten'],
    ['de', 'where', 'Wo sehe ich meine Chats?'],
    ['es', 'open', 'Abre mis mensajes'],
    ['fr', 'open', 'Ouvre mes messages'],
    ['sr', 'open', 'Otvori moje poruke'],
    ['pl', 'open', 'Otwórz moje wiadomości'],
    ['pt', 'open', 'Abre as minhas mensagens'],
    ['ru', 'open', 'Открой мои сообщения'],
    ['tr', 'open', 'Mesajlarımı aç'],
    ['ar', 'open', 'افتح رسائلي'],
    ['zh', 'open', '打开我的消息'],
  ], { forbid: [...NEWS, 'INBOX.ARCHIVED'] }),

  // ── My Journey ──────────────────────────────────────────────────────────
  ...screen('journey', ['AUTOPILOT.MY_JOURNEY'], [
    ['en', 'open', 'Open my journey'],
    ['en', 'where', 'Where do I see my journey sessions?'],
    ['de', 'open', 'Öffne meine Journey'],
    ['de', 'where', 'Wo finde ich meine Reise?'],
    ['es', 'open', 'Abre mi viaje'],
    ['fr', 'open', 'Ouvre mon parcours'],
    ['sr', 'open', 'Otvori moje putovanje'],
  ], { forbid: ['LIFE_COMPASS.OVERLAY', 'PROFILE.ME', ...INDEX] }),

  // ── Vitana Index ────────────────────────────────────────────────────────
  ...screen('index', INDEX, [
    ['en', 'open', 'Open my Vitana Index'],
    ['en', 'where', 'Where can I see my Vitana Index score?'],
    ['de', 'open', 'Öffne meinen Vitana Index'],
    ['de', 'where', 'Wo sehe ich meinen Vitana-Index?'],
    ['es', 'open', 'Muéstrame mi Índice Vitana'],
    ['fr', 'open', 'Montre-moi mon indice Vitana'],
    ['sr', 'open', 'Pokaži mi moj Vitana indeks'],
    ['pl', 'open', 'Pokaż mój Vitana Index'],
    ['ru', 'open', 'Покажи мой индекс Витана'],
  ], { forbid: ['LIFE_COMPASS.OVERLAY', 'ASSISTANT.OVERVIEW'] }),

  // ── Life Compass ────────────────────────────────────────────────────────
  ...screen('compass', ['LIFE_COMPASS.OVERLAY'], [
    ['en', 'open', 'Open my Life Compass'],
    ['en', 'where', 'Where can I see my life goals?'],
    ['de', 'open', 'Öffne meinen Life Compass'],
    ['de', 'open', 'Zeig mir meinen Lebenskompass'],
    ['es', 'open', 'Abre mi brújula de vida'],
  ], { forbid: INDEX }),

  // ── Health ──────────────────────────────────────────────────────────────
  ...screen('biology', ['HEALTH.MY_BIOLOGY', 'HEALTH.BIOMARKER_RESULTS'], [
    ['en', 'open', 'Show me my biology'],
    ['en', 'where', 'Where can I see my blood test results?'],
    ['de', 'open', 'Zeig mir meine Biologie'],
    ['de', 'where', 'Wo sehe ich meine Blutwerte?'],
    ['es', 'where', '¿Dónde veo mis resultados de análisis de sangre?'],
    ['sr', 'where', 'Gde mogu da vidim rezultate krvi?'],
  ], { forbid: COMMERCE_WRONG }),

  ...screen('supplements-mine', ['HEALTH.SUPPLEMENTS'], [
    ['en', 'open', 'Show my supplements'],
    ['en', 'where', 'Where do I see which supplements I take?'],
    ['de', 'open', 'Zeig mir meine Nahrungsergänzungsmittel'],
  ], { forbid: ['DISCOVER.CART'] }),

  ...screen('health-plans', ['HEALTH.PLANS'], [
    ['en', 'open', 'Open my health plans'],
    ['de', 'open', 'Öffne meine Gesundheitspläne'],
  ]),

  ...screen('health-tracker', ['HEALTH.TRACKER'], [
    ['en', 'open', 'Open the health tracker'],
    ['en', 'where', 'Where do I log my steps?'],
    ['de', 'where', 'Wo trage ich meine Schritte ein?'],
  ]),

  ...screen('pillars', ['HEALTH.PILLARS'], [
    ['en', 'open', 'Show me the health pillars'],
    ['de', 'open', 'Zeig mir die Gesundheitssäulen'],
  ]),

  // ── Diary / memory ──────────────────────────────────────────────────────
  ...screen('diary', DIARY, [
    ['en', 'open', 'Open my diary'],
    ['en', 'where', 'Where can I write my daily diary?'],
    ['de', 'open', 'Öffne mein Tagebuch'],
    ['de', 'where', 'Wo schreibe ich mein Tagebuch?'],
    ['es', 'open', 'Abre mi diario'],
    ['fr', 'open', 'Ouvre mon journal intime'],
    ['sr', 'open', 'Otvori moj dnevnik'],
  ], { forbid: ['MEMORY.DIARY_BUGS'] }),

  ...screen('memory', ['MEMORY.OVERVIEW', 'MEMORY.TIMELINE', 'MEMORY.RECALL'], [
    ['en', 'open', 'Open my Memory Garden'],
    ['en', 'where', 'Where can I see what you remember about me?'],
    ['de', 'open', 'Öffne meinen Erinnerungsgarten'],
  ]),

  // ── Calendar / reminders ────────────────────────────────────────────────
  ...screen('calendar', ['CALENDAR.OVERVIEW'], [
    ['en', 'open', 'Open my calendar'],
    ['en', 'where', 'Where can I see my appointments?'],
    ['de', 'open', 'Öffne meinen Kalender'],
    ['de', 'where', 'Wo sehe ich meine Termine?'],
    ['es', 'open', 'Abre mi calendario'],
    ['fr', 'open', 'Ouvre mon calendrier'],
    ['sr', 'open', 'Otvori moj kalendar'],
  ]),

  ...screen('reminders', REMINDERS, [
    ['en', 'open', 'Show my reminders'],
    ['de', 'open', 'Zeig mir meine Erinnerungen'],
  ], { forbid: ['MEMORY.OVERVIEW'] }),

  // ── Community ───────────────────────────────────────────────────────────
  ...screen('events', EVENTS, [
    ['en', 'open', 'Show me community events'],
    ['en', 'where', 'Where can I find meetups near me?'],
    ['de', 'open', 'Zeig mir Community-Events'],
    ['de', 'where', 'Wo finde ich Treffen?'],
    ['es', 'open', 'Muéstrame los eventos'],
    ['fr', 'open', 'Montre-moi les événements'],
    ['sr', 'open', 'Pokaži mi događaje'],
  ], { forbid: ['PROFILE.PUBLIC', 'PROFILE.ME', 'DISCOVER.PROVIDER_PROFILE', 'BUSINESS.SERVICES_EVENTS'] }),

  ...screen('live-rooms', LIVE, [
    ['en', 'open', 'Open live rooms'],
    ['en', 'where', 'Where can I join a live session?'],
    ['de', 'open', 'Öffne die Live-Räume'],
  ]),

  ...screen('groups', ['COMM.GROUPS'], [
    ['en', 'open', 'Show me the groups'],
    ['de', 'open', 'Zeig mir die Gruppen'],
    ['es', 'open', 'Muéstrame los grupos'],
  ], { forbid: ['COMM.GROUP_DETAIL'] }),

  ...screen('members', ['COMM.MEMBERS'], [
    ['en', 'open', 'Show me the community members'],
    ['en', 'where', 'Where can I see who else is in the community?'],
    ['de', 'open', 'Zeig mir die Mitglieder'],
  ], { forbid: ['PROFILE.ME', 'PROFILE.PUBLIC'] }),

  ...screen('matches', MATCHES, [
    ['en', 'open', 'Show me my matches'],
    ['de', 'open', 'Zeig mir meine Matches'],
  ], { forbid: ['INTENTS.MATCH_DETAIL'] }),

  ...screen('find-partner', ['COMM.FIND_PARTNER', 'COMM.FIND_PARTNER_BOARD'], [
    ['en', 'where', 'Where can I find a training partner?'],
    ['de', 'where', 'Wo finde ich einen Trainingspartner?'],
  ]),

  ...screen('media', ['COMM.MEDIA_HUB', 'COMM.MEDIA_PODCASTS', 'COMM.MEDIA_SHORTS', 'COMM.MEDIA_MUSIC'], [
    ['en', 'open', 'Open the media hub'],
    ['en', 'where', 'Where can I listen to podcasts?'],
    ['de', 'where', 'Wo kann ich Podcasts hören?'],
  ]),

  // ── Discover / commerce ─────────────────────────────────────────────────
  ...screen('cart', ['DISCOVER.CART'], [
    ['en', 'open', 'Open my shopping cart'],
    ['de', 'open', 'Öffne meinen Warenkorb'],
    ['sr', 'open', 'Otvori moju korpu'],
  ]),

  ...screen('orders', ORDERS, [
    ['en', 'open', 'Show my orders'],
    ['en', 'where', 'Where can I track my order?'],
    ['de', 'open', 'Zeig mir meine Bestellungen'],
  ], { forbid: ['DISCOVER.CART'] }),

  ...screen('shop-supplements', SUPPLEMENTS_SHOP, [
    ['en', 'where', 'Where can I buy supplements?'],
    ['de', 'where', 'Wo kann ich Nahrungsergänzungsmittel kaufen?'],
  ], { forbid: ['HEALTH.SUPPLEMENTS'] }),

  ...screen('doctors', ['DISCOVER.DOCTORS_COACHES'], [
    ['en', 'where', 'Where can I find a doctor or a coach?'],
    ['de', 'where', 'Wo finde ich einen Arzt oder Coach?'],
  ]),

  ...screen('discover', ['DISCOVER.OVERVIEW', 'DISCOVER.MARKETPLACE'], [
    ['en', 'open', 'Open discover'],
    ['de', 'open', 'Öffne Entdecken'],
  ]),

  // ── Wallet ──────────────────────────────────────────────────────────────
  ...screen('wallet', WALLET, [
    ['en', 'open', 'Open my wallet'],
    ['en', 'where', 'Where can I see my balance?'],
    ['de', 'open', 'Öffne meine Wallet'],
    ['de', 'where', 'Wo sehe ich mein Guthaben?'],
    ['es', 'open', 'Abre mi billetera'],
    ['sr', 'open', 'Otvori moj novčanik'],
  ]),

  ...screen('subscriptions', ['WALLET.SUBSCRIPTIONS', 'SETTINGS.BILLING_PLAN'], [
    ['en', 'where', 'Where can I see my subscription?'],
    ['de', 'where', 'Wo sehe ich mein Abo?'],
  ]),

  ...screen('rewards', ['WALLET.REWARDS'], [
    ['en', 'where', 'Where can I see my rewards?'],
  ]),

  // ── Profile / settings ──────────────────────────────────────────────────
  ...screen('profile', ['PROFILE.ME'], [
    ['en', 'open', 'Open my profile'],
    ['en', 'where', 'Where can I change my profile picture?'],
    ['de', 'open', 'Öffne mein Profil'],
    ['es', 'open', 'Abre mi perfil'],
    ['fr', 'open', 'Ouvre mon profil'],
    ['sr', 'open', 'Otvori moj profil'],
  ], { forbid: ['PROFILE.PUBLIC', 'COMM.MEMBERS'] }),

  ...screen('settings', ['SETTINGS.OVERVIEW'], [
    ['en', 'open', 'Open settings'],
    ['de', 'open', 'Öffne die Einstellungen'],
  ]),

  ...screen('notifications', ['SETTINGS.NOTIFICATIONS'], [
    ['en', 'where', 'Where can I turn off notifications?'],
    ['de', 'where', 'Wo schalte ich Benachrichtigungen aus?'],
  ]),

  ...screen('language', ['SETTINGS.PREFERENCES_LANGUAGE', 'SETTINGS.PREFERENCES'], [
    ['en', 'where', 'Where can I change the app language?'],
    ['de', 'where', 'Wo ändere ich die Sprache?'],
  ]),

  ...screen('privacy', ['SETTINGS.PRIVACY', 'SETTINGS.PRIVACY_VISIBILITY', 'PROFILE.PRIVACY'], [
    ['en', 'open', 'Open my privacy settings'],
    ['de', 'open', 'Öffne die Datenschutzeinstellungen'],
  ], { forbid: ['PUBLIC.PRIVACY'] }),

  ...screen('billing', ['SETTINGS.BILLING', 'SETTINGS.BILLING_INVOICES'], [
    ['en', 'where', 'Where can I download my invoices?'],
    ['de', 'where', 'Wo finde ich meine Rechnungen?'],
  ]),

  ...screen('support', SUPPORT, [
    ['en', 'where', 'Where can I contact support?'],
    ['de', 'where', 'Wo erreiche ich den Support?'],
  ]),

  ...screen('connectors', ['SETTINGS.CONNECTED_APPS', 'CONNECTORS.FITNESS', 'CONNECTORS.HEALTH'], [
    ['en', 'where', 'Where can I connect my fitness tracker?'],
    ['de', 'where', 'Wo verbinde ich meine Fitness-App?'],
  ]),

  ...screen('voice-settings', ['SETTINGS.VOICE_AI'], [
    ['en', 'where', "Where can I change Vitana's voice?"],
  ]),

  // ── Business ────────────────────────────────────────────────────────────
  ...screen('business', ['BUSINESS.OVERVIEW'], [
    ['en', 'open', 'Open the business hub'],
    ['de', 'open', 'Öffne den Business Hub'],
  ]),

  ...screen('earnings', ['BUSINESS.INSIGHTS_EARNINGS', 'BUSINESS.ANALYTICS', 'WALLET.REWARDS'], [
    ['en', 'where', 'Where can I see how much I earned?'],
  ]),

  // ── Not navigation at all ───────────────────────────────────────────────
  ...screen('none', [], [
    ['en', 'none', 'How are you today?'],
    ['en', 'none', 'Tell me a joke'],
    ['en', 'none', 'What is a good breakfast for longevity?'],
    ['de', 'none', 'Wie geht es dir?'],
    ['de', 'none', 'Was ist gut für meinen Schlaf?'],
    ['es', 'none', '¿Qué tal estás?'],
    ['sr', 'none', 'Kako si danas?'],
  ]),
];
