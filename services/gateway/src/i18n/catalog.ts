// Server-side i18n catalog for strings the gateway emits directly to users
// (push notifications, cron-triggered messages, email subjects, etc.) where
// the frontend can't intercept and translate.
//
// Mirrors the shape of vitana-v1's per-shard catalog but lives here because:
//   - Scheduled notifications run in cron jobs with no client locale to consume.
//   - Mobile push notifications surface on the device lock-screen pre-app-open.
//
// German is the default. Translations live in ./locales/<locale>.json — the
// TypeScript here is only the key registry, the loader and the fallback chain.
//
// VTID-03509 — es/sr used to be `{ ...EN }`, i.e. literal English claiming to
// be Spanish and Serbian. That is worse than an obvious gap: `tt()` found a
// value for every key, so no fallback ever fired and no coverage check could
// see a problem, while Spanish users got English push notifications on their
// lock screen. Locale files are now `Partial<LocaleCatalog>` and a genuinely
// missing key falls back visibly (see `tt`), so coverage is measurable.
export type GatewayLocale = 'de' | 'en' | 'es' | 'sr' | 'fr' | 'pt' | 'ru' | 'pl';

/** Every locale the gateway can emit. Order is not significant. */
export const GATEWAY_LOCALES: readonly GatewayLocale[] = [
  'de', 'en', 'es', 'sr', 'fr', 'pt', 'ru', 'pl',
] as const;

export const GATEWAY_DEFAULT_LOCALE: GatewayLocale = 'de';

// Locale-agnostic key registry. Add new keys here, then add translations below.
export type GatewayI18nKey =
  | 'notif.morning_briefing.title'
  | 'notif.morning_briefing.body'
  | 'notif.diary_reminder.title'
  | 'notif.diary_reminder.body'
  | 'notif.weekly_digest.title'
  | 'notif.weekly_digest.body'
  | 'notif.weekly_summary.title'
  | 'notif.weekly_summary.body'
  // BOOTSTRAP-MEMORY-DAILY-LEARNING: felt-learning surfaces
  | 'notif.daily_learning.title'
  | 'notif.daily_learning.body'
  | 'notif.memory_match.title'
  | 'notif.memory_match.body'
  | 'notif.weekly_reflection.title'
  | 'notif.weekly_reflection.body'
  | 'notif.meetup_starting_soon.title'
  | 'notif.meetup_starting_soon.body'
  | 'notif.meetup_starting_now.title'
  | 'notif.meetup_starting_now.body'
  | 'notif.event_today.title'
  | 'notif.event_today.body'
  | 'notif.recommendation_expiring.title'
  | 'notif.recommendation_expiring.body'
  | 'notif.signal_expired.title'
  | 'notif.signal_expired.body'
  | 'notif.reminder.title'
  | 'notif.fallback_app_name'
  // Live room goes live → notify everyone who tapped "Notify me" on the scheduled session.
  | 'notif.live_going_live.title'
  | 'notif.live_going_live.body'
  // Social: someone liked or commented on your post (community feed + profile)
  | 'notif.post_like.title'
  | 'notif.post_like.body'
  | 'notif.post_comment.title'
  | 'notif.post_comment.body'
  // Feature-announcement News Feed cards (BOOTSTRAP-FEATURE-ANNOUNCEMENTS) —
  // title is a generic "New feature: {feature}" template; the body is the
  // announcement's own per-locale description, not a catalog key (it's
  // one-off editorial copy authored per announcement, not recurring UI chrome).
  | 'notif.feature_announcement.title'
  // Daily "Did You Know" tip about an EXISTING feature (BOOTSTRAP-DAILY-FEATURE-TIP)
  // — distinct wording from feature_announcement above ("New feature: X"
  // would be wrong for something that already exists). Body is the tip's own
  // per-locale description, same one-off-copy convention as above.
  | 'notif.feature_tip.title'
  // Daily pace check (claude/daily-pace-notifications)
  | 'notif.daily_pace.on_track.title'
  | 'notif.daily_pace.on_track.body'
  | 'notif.daily_pace.slightly_behind.title'
  | 'notif.daily_pace.slightly_behind.body'
  | 'notif.daily_pace.falling_behind.title'
  | 'notif.daily_pace.falling_behind.body'
  | 'notif.celebration.daily_goal.title'
  | 'notif.celebration.daily_goal.body'
  | 'notif.celebration.phase_milestone.title'
  | 'notif.celebration.phase_milestone.body'
  | 'notif.celebration.progress_25.title'
  | 'notif.celebration.progress_25.body'
  | 'notif.celebration.progress_50.title'
  | 'notif.celebration.progress_50.body'
  | 'notif.celebration.progress_75.title'
  | 'notif.celebration.progress_75.body'
  | 'notif.celebration.progress_100.title'
  | 'notif.celebration.progress_100.body'
  // Notification-category labels surfaced on Settings → Notifications page.
  // Mapped from notification_categories.slug (display_name + description).
  | 'notif.category.chat.direct_messages.label'
  | 'notif.category.chat.direct_messages.desc'
  | 'notif.category.chat.orb_messages.label'
  | 'notif.category.chat.orb_messages.desc'
  | 'notif.category.chat.followup_reminders.label'
  | 'notif.category.chat.followup_reminders.desc'
  | 'notif.category.calendar.event_reminders.label'
  | 'notif.category.calendar.event_reminders.desc'
  | 'notif.category.calendar.morning_briefing.label'
  | 'notif.category.calendar.morning_briefing.desc'
  | 'notif.category.calendar.weekly_digest.label'
  | 'notif.category.calendar.weekly_digest.desc'
  | 'notif.category.calendar.rsvp_updates.label'
  | 'notif.category.calendar.rsvp_updates.desc'
  | 'notif.category.community.group_activity.label'
  | 'notif.category.community.group_activity.desc'
  | 'notif.category.community.meetups.label'
  | 'notif.category.community.meetups.desc'
  | 'notif.category.community.live_rooms.label'
  | 'notif.category.community.live_rooms.desc'
  | 'notif.category.community.connections_social.label'
  | 'notif.category.community.connections_social.desc'
  // Priority of the Day banner (VTID-01947) — awareness-driven Home card +
  // morning-brief fallback body. Emitted by the gateway as a full sentence,
  // so it must be localized server-side (the frontend renders it verbatim).
  | 'priority.absence_streak.named'
  | 'priority.absence_streak'
  | 'priority.absence.named.day'
  | 'priority.absence.named.days'
  | 'priority.absence.day'
  | 'priority.absence.days'
  | 'priority.overdue.one'
  | 'priority.overdue.many'
  | 'priority.goal_prosperity_idle'
  | 'priority.welcome_wave'
  | 'priority.welcome_generic'
  | 'priority.open_recs.one'
  | 'priority.open_recs.many'
  | 'priority.journey_day'
  | 'priority.greeting.morning.named'
  | 'priority.greeting.morning'
  | 'priority.greeting.afternoon.named'
  | 'priority.greeting.afternoon'
  | 'priority.greeting.evening.named'
  | 'priority.greeting.evening'
  // Autopilot recommendation identity (recommendation-identity work) — the
  // "Vitana empfiehlt" header shown on every AI-generated recommendation card
  // so the source is never rendered as a bare "AI" label.
  | 'recommendation.vitana_label'
  // BOOTSTRAP-NOVA-SONIC-VOICE: greeting AUDIO bridge — a short, near-instant
  // TTS phrase spoken while the real (context-heavy) upstream greeting is
  // still being generated, so the user hears Vitana immediately instead of
  // silence. {date} is locale-formatted by the caller; {line} is one of a
  // small rotating motivational-line pool below.
  | 'orb.greeting_bridge.morning'
  | 'orb.greeting_bridge.afternoon'
  | 'orb.greeting_bridge.evening'
  | 'orb.greeting_bridge.transition'
  | 'orb.greeting_bridge.line_1'
  | 'orb.greeting_bridge.line_2'
  | 'orb.greeting_bridge.line_3'
  | 'orb.greeting_bridge.line_4'
  | 'orb.greeting_bridge.line_5';

type LocaleCatalog = Record<GatewayI18nKey, string>;

import deJson from './locales/de.json';
import enJson from './locales/en.json';
import esJson from './locales/es.json';
import srJson from './locales/sr.json';
import frJson from './locales/fr.json';
import ptJson from './locales/pt.json';
import ruJson from './locales/ru.json';
import plJson from './locales/pl.json';

// DE and EN are the two locales that must be complete: DE is the default and
// EN is the universal fallback, so between them every key is always resolvable.
// Typing them as the full LocaleCatalog makes `tsc` fail the build if a key is
// added to GatewayI18nKey without a DE/EN translation.
const DE: LocaleCatalog = deJson;
const EN: LocaleCatalog = enJson;

// Everything else may legitimately lag behind a freshly-added key. Partial is
// the honest type — it is what makes the fallback in `tt()` reachable instead
// of being masked by an English value pretending to be a translation.
const ES: Partial<LocaleCatalog> = esJson;
const SR: Partial<LocaleCatalog> = srJson;
const FR: Partial<LocaleCatalog> = frJson;
const PT: Partial<LocaleCatalog> = ptJson;
const RU: Partial<LocaleCatalog> = ruJson;
const PL: Partial<LocaleCatalog> = plJson;

const CATALOGS: Record<GatewayLocale, Partial<LocaleCatalog>> = {
  de: DE,
  en: EN,
  es: ES,
  sr: SR,
  fr: FR,
  pt: PT,
  ru: RU,
  pl: PL,
};

/**
 * Keys a locale is missing relative to DE. Used by the coverage test and by
 * `GET /api/v1/admin/i18n-coverage` so a gap is a number someone can watch,
 * not something discovered by a user reading English on their lock screen.
 */
export function missingKeysForLocale(locale: GatewayLocale): GatewayI18nKey[] {
  const cat = CATALOGS[locale] ?? {};
  return (Object.keys(DE) as GatewayI18nKey[]).filter((k) => typeof cat[k] !== 'string');
}

/**
 * Resolve a key against the user's locale, substitute {placeholders}.
 *
 * Fallback order is locale → EN → DE → the key itself. EN comes before DE
 * deliberately: the fallback only fires when the user's own locale is missing
 * a key, and at that point a French or Polish user is far more likely to read
 * English than German. DE stays as the final backstop because it is the
 * default locale and is guaranteed complete.
 */
export function tt(
  key: GatewayI18nKey,
  locale: GatewayLocale | string | null | undefined,
  params?: Record<string, string | number>,
): string {
  const lc = normalizeLocale(locale);
  const value =
    CATALOGS[lc]?.[key] ?? CATALOGS.en[key] ?? CATALOGS[GATEWAY_DEFAULT_LOCALE][key] ?? key;
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (match, name: string) => {
    const replacement = params[name];
    return replacement === undefined ? match : String(replacement);
  });
}

// Full language names (English + native) → locale code. The assistant-inferred
// `memory_facts.preferred_language` fallback stores values as language WORDS
// ("German", "Serbian", "Spanish") rather than ISO codes, so the ISO-prefix
// checks below silently mis-resolve them: "serbian" starts with "se" (not "sr")
// and "spanish" starts with "sp" (not "es"), so both used to collapse to the
// default locale — Serbian users were served German content. Match names first.
//
// VTID-03509 extended this to the 18 Aug locale set, and the trap got worse
// rather than better: "portuguese", "polish", "portugiesisch" and "polnisch"
// ALL begin with "po" — matching neither 'pt' nor 'pl', and colliding with
// each other. A word-form value for either language would resolve to German
// without an explicit entry here, so these are not optional niceties.
const LANGUAGE_NAME_TO_LOCALE: Record<string, GatewayLocale> = {
  german: 'de',
  deutsch: 'de',
  english: 'en',
  englisch: 'en',
  serbian: 'sr',
  serbisch: 'sr',
  srpski: 'sr',
  spanish: 'es',
  spanisch: 'es',
  espanol: 'es',
  'español': 'es',
  french: 'fr',
  franzosisch: 'fr',
  'französisch': 'fr',
  francais: 'fr',
  'français': 'fr',
  portuguese: 'pt',
  portugiesisch: 'pt',
  portugues: 'pt',
  'português': 'pt',
  russian: 'ru',
  russisch: 'ru',
  russkiy: 'ru',
  'русский': 'ru',
  polish: 'pl',
  polnisch: 'pl',
  polski: 'pl',
};

/**
 * Plain English language names, for building translate-into-X instructions.
 *
 * VTID-03509 — this map (and the register hints below) previously existed as
 * THREE independent copies: here-equivalent literals in `catalog-localizer.ts`,
 * `journey/goal-plan-i18n.ts`, and `llm-locale.ts`. Adding a locale updated
 * some and not others, which is precisely how a "supported" language ends up
 * silently translated into German. Import these; do not re-declare them.
 */
export const LOCALE_ENGLISH_NAME: Record<GatewayLocale, string> = {
  de: 'German',
  en: 'English',
  es: 'Spanish',
  sr: 'Serbian',
  fr: 'French',
  pt: 'Portuguese',
  ru: 'Russian',
  pl: 'Polish',
};

/**
 * Informal-register hint appended to translate instructions. The brand voice
 * is informal in every language; without this most LLMs pick the formal
 * register for European languages and the copy reads like a bank letter.
 * Leading space is intentional — callers concatenate directly.
 */
export const LOCALE_INFORMAL_HINT: Partial<Record<GatewayLocale, string>> = {
  de: ' Use the informal du-form (never Sie/Ihr/Ihnen).',
  sr: ' Use the informal ti-form.',
  es: ' Use the informal tú-form.',
  fr: ' Use the informal tu-form (tutoyer, never vous).',
  pt: ' Use the informal tu-form (European Portuguese, never você/o senhor).',
  ru: ' Use the informal ты-form (never вы).',
  pl: ' Use the informal ty-form (never Pan/Pani).',
};

/**
 * Like `normalizeLocale`, but returns null instead of the default when the
 * input is not recognised. Callers that must distinguish "the user asked for
 * German" from "we have no idea what this is" need this — `normalizeLocale`
 * collapses both to 'de', which is correct for rendering a string and wrong
 * for deciding whether to constrain an LLM to a language at all.
 */
export function resolveLocaleStrict(loc: string | null | undefined): GatewayLocale | null {
  if (!loc) return null;
  const lower = loc.toLowerCase().trim();
  const byName = LANGUAGE_NAME_TO_LOCALE[lower];
  if (byName) return byName;
  for (const code of GATEWAY_LOCALES) {
    if (lower.startsWith(code)) return code;
  }
  return null;
}

export function normalizeLocale(loc: string | null | undefined): GatewayLocale {
  if (!loc) return GATEWAY_DEFAULT_LOCALE;
  const lower = loc.toLowerCase().trim();
  // Exact language-name match takes priority over ISO-prefix heuristics so
  // word-form values resolve correctly regardless of their leading letters.
  const byName = LANGUAGE_NAME_TO_LOCALE[lower];
  if (byName) return byName;
  // ISO-code prefixes ('de-DE' → 'de'). Only reached when the value is not a
  // language word, because the name map above already returned.
  for (const code of GATEWAY_LOCALES) {
    if (lower.startsWith(code)) return code;
  }
  return GATEWAY_DEFAULT_LOCALE;
}
