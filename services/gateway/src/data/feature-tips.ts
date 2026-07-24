/**
 * Curated content pool for the automatic once-a-day "Did You Know" News Feed
 * card (BOOTSTRAP-DAILY-FEATURE-TIP). Consumed by
 * POST /api/v1/scheduled-notifications/daily-feature-tip, which advances
 * through this list in order (tracked per-tenant in did_you_know_state) and
 * wraps around once exhausted — never repeats the same tip two days running.
 *
 * deepLink is a real, existing route (verified against src/App.tsx in
 * vitana-v1) and is PATH-based, not query-string — required so the tip's
 * push notification survives an Appilix Android WebView notification tap
 * (see 20260625000000_post_notification_deeplink.sql in vitana-v1).
 *
 * DE is du-form per platform CLAUDE.md's i18n catalog-quality rule.
 */

export interface FeatureTip {
  key: string;
  title: { en: string; de: string };
  description: { en: string; de: string };
  deepLink: string;
}

export const FEATURE_TIPS: FeatureTip[] = [
  {
    key: 'vitana-index',
    title: { en: 'Your Vitana Index', de: 'Dein Vitana-Index' },
    description: {
      en: 'Your Vitana Index turns your health data into one clear number, updated daily — check it anytime to see where you stand.',
      de: 'Dein Vitana-Index fasst deine Gesundheitsdaten in einer klaren Zahl zusammen, täglich aktualisiert — schau jederzeit rein, um zu sehen, wo du stehst.',
    },
    deepLink: '/health/vitana-index',
  },
  {
    key: 'autopilot',
    title: { en: 'Autopilot', de: 'Autopilot' },
    description: {
      en: 'Autopilot surfaces small, personalized actions based on your goals and habits — so you always know what to do next.',
      de: 'Autopilot zeigt dir kleine, persönliche Schritte passend zu deinen Zielen und Gewohnheiten — so weißt du immer, was als Nächstes dran ist.',
    },
    deepLink: '/autopilot',
  },
  {
    key: 'live-rooms',
    title: { en: 'Live Rooms', de: 'Live-Räume' },
    description: {
      en: 'Live Rooms let you join real-time voice conversations with other members — drop in whenever one is happening.',
      de: 'In Live-Räumen kannst du in Echtzeit mit anderen Mitgliedern sprechen — steig einfach ein, wenn gerade einer läuft.',
    },
    deepLink: '/comm/live-rooms',
  },
  {
    key: 'meetups',
    title: { en: 'Events & Meetups', de: 'Events & Treffen' },
    description: {
      en: 'Browse upcoming community events and meetups, and RSVP right from the app to save your spot.',
      de: 'Entdecke kommende Community-Events und Treffen und sag direkt in der App zu, um dir deinen Platz zu sichern.',
    },
    deepLink: '/comm/events-meetups',
  },
  {
    key: 'daily-diary',
    title: { en: 'Daily Diary', de: 'Tägliches Tagebuch' },
    description: {
      en: 'A quick daily diary entry helps track your mood and progress over time — it only takes a minute.',
      de: 'Ein kurzer Tagebucheintrag pro Tag hilft dir, deine Stimmung und Fortschritte im Blick zu behalten — dauert nur eine Minute.',
    },
    deepLink: '/daily-diary',
  },
  {
    key: 'matches',
    title: { en: 'Your Matches', de: 'Deine Matches' },
    description: {
      en: 'MAXINA suggests other members who share your goals and interests — check your matches to find your people.',
      de: 'MAXINA schlägt dir andere Mitglieder mit ähnlichen Zielen und Interessen vor — schau bei deinen Matches vorbei.',
    },
    deepLink: '/me/matches',
  },
  {
    key: 'find-partner',
    title: { en: 'Find a Partner', de: 'Partner finden' },
    description: {
      en: 'Looking for someone to team up with on a specific goal? Find a Partner connects you with members looking for the same thing.',
      de: 'Suchst du jemanden für ein bestimmtes Ziel? Mit Partner finden triffst du Mitglieder mit demselben Vorhaben.',
    },
    deepLink: '/comm/find-partner',
  },
  {
    key: 'my-business',
    title: { en: 'My Business', de: 'Mein Business' },
    description: {
      en: 'Recommend products and services you love through My Business, and earn when others buy through your link.',
      de: 'Empfiehl Produkte und Dienstleistungen, die du liebst, über Mein Business — und verdiene mit, wenn andere über deinen Link kaufen.',
    },
    deepLink: '/business',
  },
  {
    key: 'memory-timeline',
    title: { en: 'Your Memory Timeline', de: 'Deine Erinnerungs-Zeitleiste' },
    description: {
      en: 'MAXINA remembers what you share over time — your Memory Timeline lets you look back on your own journey.',
      de: 'MAXINA merkt sich, was du im Laufe der Zeit teilst — in deiner Erinnerungs-Zeitleiste kannst du auf deine eigene Reise zurückblicken.',
    },
    deepLink: '/memory/timeline',
  },
  {
    key: 'assistant-voice',
    title: { en: 'Talk to Maxina', de: 'Sprich mit Maxina' },
    description: {
      en: 'You can talk to Maxina with your voice, not just text — open the assistant and just start speaking.',
      de: 'Du kannst mit Maxina auch per Sprache reden, nicht nur per Text — öffne den Assistenten und sprich einfach los.',
    },
    deepLink: '/assistant',
  },
  {
    key: 'discover',
    title: { en: 'Discover', de: 'Entdecken' },
    description: {
      en: 'Discover curates supplements, services, and offers picked for longevity — a good place to browse when you need something new.',
      de: 'Entdecken zeigt dir ausgewählte Nahrungsergänzungsmittel, Dienstleistungen und Angebote rund um Longevity — ideal, wenn du mal etwas Neues suchst.',
    },
    deepLink: '/discover',
  },
  {
    key: 'wallet',
    title: { en: 'Your Wallet', de: 'Deine Wallet' },
    description: {
      en: 'Your Wallet tracks credits, rewards, and payouts in one place — check it to see what you have earned.',
      de: 'Deine Wallet zeigt Guthaben, Prämien und Auszahlungen an einem Ort — schau nach, was du schon verdient hast.',
    },
    deepLink: '/wallet',
  },
];
