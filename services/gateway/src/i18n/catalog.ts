// Server-side i18n catalog for strings the gateway emits directly to users
// (push notifications, cron-triggered messages, email subjects, etc.) where
// the frontend can't intercept and translate.
//
// Mirrors the shape of vitana-v1's per-shard catalog but lives here because:
//   - Scheduled notifications run in cron jobs with no client locale to consume.
//   - Mobile push notifications surface on the device lock-screen pre-app-open.
//
// German is the default. New keys MUST be added to all GA locales (de, en).
// Draft locales (sr, es) can fall back to en until they go GA.

export type GatewayLocale = 'de' | 'en' | 'sr' | 'es';

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
  // Daily pace check (claude/daily-pace-notifications)
  | 'notif.daily_pace.on_track.title'
  | 'notif.daily_pace.on_track.body'
  | 'notif.daily_pace.slightly_behind.title'
  | 'notif.daily_pace.slightly_behind.body'
  | 'notif.daily_pace.falling_behind.title'
  | 'notif.daily_pace.falling_behind.body'
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
  | 'priority.greeting.evening';

type LocaleCatalog = Record<GatewayI18nKey, string>;

const DE: LocaleCatalog = {
  'notif.morning_briefing.title': 'Dein Morgenbriefing',
  'notif.morning_briefing.body': 'Schau dir an, was heute auf dich wartet.',
  'notif.diary_reminder.title': 'Tagebuch-Erinnerung',
  'notif.diary_reminder.body': 'Nimm dir einen Moment, um über deinen Tag nachzudenken.',
  'notif.weekly_digest.title': 'Wöchentlicher Community-Überblick',
  'notif.weekly_digest.body': 'Sieh dir an, was diese Woche in deiner Community passiert ist.',
  'notif.weekly_summary.title': 'Deine wöchentliche Zusammenfassung',
  'notif.weekly_summary.body': 'Hier ist ein Überblick über deine Aktivität und deinen Fortschritt diese Woche.',
  'notif.weekly_reflection.title': 'Wöchentliche Reflexion',
  'notif.weekly_reflection.body': 'Nimm dir ein paar Minuten Zeit, um über deine Woche nachzudenken und Absichten zu setzen.',
  'notif.meetup_starting_soon.title': 'Meetup beginnt bald',
  'notif.meetup_starting_soon.body': '"{title}" beginnt in etwa 15 Minuten.',
  'notif.meetup_starting_now.title': 'Meetup beginnt jetzt!',
  'notif.meetup_starting_now.body': '"{title}" startet gerade. Sei dabei!',
  'notif.event_today.title': 'Du hast heute ein Event',
  'notif.event_today.body': '"{title}" um {time}.',
  'notif.recommendation_expiring.title': 'Empfehlung läuft ab',
  'notif.recommendation_expiring.body': '"{title}" läuft bald ab. Jetzt handeln!',
  'notif.signal_expired.title': 'Signal abgelaufen',
  'notif.signal_expired.body': 'Ein prädiktives Signal ist abgelaufen.',
  'notif.reminder.title': '🔔 Erinnerung',
  'notif.fallback_app_name': 'Vitana',
  'notif.live_going_live.title': '🔴 Jetzt live!',
  'notif.live_going_live.body': '„{title}" hat gerade begonnen. Schau jetzt rein.',
  // Daily pace check
  'notif.daily_pace.on_track.title': 'Auf Kurs ✨',
  'notif.daily_pace.on_track.body': 'Du bist auf einem guten Weg. Schließ heute noch deinen Tagesplan ab — dein Ziel kommt näher.',
  'notif.daily_pace.slightly_behind.title': 'Heute geht noch was',
  'notif.daily_pace.slightly_behind.body': 'Ein, zwei Schritte vom Tagesplan reichen, um wieder mit deinem Ziel im Gleichschritt zu sein.',
  'notif.daily_pace.falling_behind.title': 'Dein Ziel wartet',
  'notif.daily_pace.falling_behind.body': 'Wir kommen vom Kurs ab. Ein kleiner Schritt heute — und du bist wieder dabei.',
  // Notification-category labels (Settings → Benachrichtigungen)
  'notif.category.chat.direct_messages.label': 'Direktnachrichten',
  'notif.category.chat.direct_messages.desc': 'Neue Nachrichten von Personen und Gruppen',
  'notif.category.chat.orb_messages.label': 'ORB-Nachrichten',
  'notif.category.chat.orb_messages.desc': 'Proaktive Nachrichten und Vorschläge von deinem KI-Assistenten',
  'notif.category.chat.followup_reminders.label': 'Folge-Erinnerungen',
  'notif.category.chat.followup_reminders.desc': 'Erinnerungen, Unterhaltungen fortzuführen',
  'notif.category.calendar.event_reminders.label': 'Event-Erinnerungen',
  'notif.category.calendar.event_reminders.desc': 'Anstehende Events und Meetups, die bald beginnen',
  'notif.category.calendar.morning_briefing.label': 'Morgenbriefing',
  'notif.category.calendar.morning_briefing.desc': 'Deine tägliche Morgenzusammenfassung und dein Tagesplan',
  'notif.category.calendar.weekly_digest.label': 'Wöchentlicher Überblick',
  'notif.category.calendar.weekly_digest.desc': 'Wöchentlicher Community-Überblick und Aktivitätszusammenfassung',
  'notif.category.calendar.rsvp_updates.label': 'Zusagen-Updates',
  'notif.category.calendar.rsvp_updates.desc': 'Bestätigungen und Updates zu deinen Zusagen',
  'notif.category.community.group_activity.label': 'Gruppenaktivität',
  'notif.category.community.group_activity.desc': 'Aktivität in deinen Gruppen — Beitritte, Meilensteine, Einladungen',
  'notif.category.community.meetups.label': 'Meetups',
  'notif.category.community.meetups.desc': 'Empfohlene Meetups und Meetup-Updates',
  'notif.category.community.live_rooms.label': 'Live-Räume',
  'notif.category.community.live_rooms.desc': 'Live-Raum-Starts, Einladungen, Zusammenfassungen und Aufzeichnungen',
  'notif.category.community.connections_social.label': 'Verbindungen & Soziales',
  'notif.category.community.connections_social.desc': 'Neue Matches, Verbindungen und soziale Aktivität',
  // Priority of the Day banner (VTID-01947)
  'priority.absence_streak.named': '{name}, willkommen zurück. Deine Tagebuch-Serie pausierte bei {streak} Tagen – lass uns sie heute fortsetzen.',
  'priority.absence_streak': 'Willkommen zurück. Deine Tagebuch-Serie pausierte bei {streak} Tagen – lass uns sie heute fortsetzen.',
  'priority.absence.named.day': '{name}, es ist {days} Tag her – schön, dass du wieder da bist.',
  'priority.absence.named.days': '{name}, es sind {days} Tage her – schön, dass du wieder da bist.',
  'priority.absence.day': 'Es ist {days} Tag her – schön, dass du wieder da bist.',
  'priority.absence.days': 'Es sind {days} Tage her – schön, dass du wieder da bist.',
  'priority.overdue.one': '{count} Journey-Aktivität wartet noch von vorhin. Lass sie uns jetzt gemeinsam angehen.',
  'priority.overdue.many': '{count} Journey-Aktivitäten warten noch von vorhin. Lass uns eine davon jetzt gemeinsam angehen.',
  'priority.goal_prosperity_idle': 'Dein Ziel zielt auf finanzielle Freiheit. Ein Business-Hub-Check-in könnte es heute voranbringen.',
  'priority.welcome_wave': 'Du bist in „{wave}“ – {description}. Lass mich dir in zwei Minuten zeigen, wie es funktioniert.',
  'priority.welcome_generic': 'Willkommen auf deiner Longevity-Reise. Lass mich dir zeigen, was wir gemeinsam tun können.',
  'priority.open_recs.one': '{count} Autopilot-Aktion ist für dich bereit. Einen Blick wert?',
  'priority.open_recs.many': '{count} Autopilot-Aktionen sind für dich bereit. Einen Blick wert?',
  'priority.journey_day': 'Tag {day} deiner Reise, in „{wave}“. Bleib dran.',
  'priority.greeting.morning.named': 'Guten Morgen, {name}. Bereit, wenn du es bist.',
  'priority.greeting.morning': 'Guten Morgen. Bereit, wenn du es bist.',
  'priority.greeting.afternoon.named': 'Guten Tag, {name}. Bereit, wenn du es bist.',
  'priority.greeting.afternoon': 'Guten Tag. Bereit, wenn du es bist.',
  'priority.greeting.evening.named': 'Guten Abend, {name}. Bereit, wenn du es bist.',
  'priority.greeting.evening': 'Guten Abend. Bereit, wenn du es bist.',
};

const EN: LocaleCatalog = {
  'notif.morning_briefing.title': 'Your Morning Briefing',
  'notif.morning_briefing.body': 'See what\'s waiting for you today.',
  'notif.diary_reminder.title': 'Diary Reminder',
  'notif.diary_reminder.body': 'Take a moment to reflect on your day.',
  'notif.weekly_digest.title': 'Weekly Community Digest',
  'notif.weekly_digest.body': 'See what happened in your community this week.',
  'notif.weekly_summary.title': 'Your Weekly Summary',
  'notif.weekly_summary.body': 'Here\'s a snapshot of your activity and progress this week.',
  'notif.weekly_reflection.title': 'Weekly Reflection',
  'notif.weekly_reflection.body': 'Take a few minutes to reflect on your week and set intentions.',
  'notif.meetup_starting_soon.title': 'Meetup Starting Soon',
  'notif.meetup_starting_soon.body': '"{title}" starts in about 15 minutes.',
  'notif.meetup_starting_now.title': 'Meetup Starting Now!',
  'notif.meetup_starting_now.body': '"{title}" is starting now. Join in!',
  'notif.event_today.title': 'You have an event today',
  'notif.event_today.body': '"{title}" at {time}.',
  'notif.recommendation_expiring.title': 'Recommendation Expiring',
  'notif.recommendation_expiring.body': '"{title}" expires soon. Act now!',
  'notif.signal_expired.title': 'Signal Expired',
  'notif.signal_expired.body': 'A predictive signal has expired.',
  'notif.reminder.title': '🔔 Reminder',
  'notif.fallback_app_name': 'Vitana',
  'notif.live_going_live.title': '🔴 Now live!',
  'notif.live_going_live.body': '"{title}" just started. Tune in now.',
  // Daily pace check
  'notif.daily_pace.on_track.title': 'On track ✨',
  'notif.daily_pace.on_track.body': "You're moving well. Wrap up today's plan — your goal is getting closer.",
  'notif.daily_pace.slightly_behind.title': "Today's still open",
  'notif.daily_pace.slightly_behind.body': "One or two steps from today's plan are enough to fall back in step with your goal.",
  'notif.daily_pace.falling_behind.title': 'Your goal is waiting',
  'notif.daily_pace.falling_behind.body': "We're drifting off course. One small step today — and you're back in.",
  // Notification-category labels (Settings → Notifications)
  'notif.category.chat.direct_messages.label': 'Direct Messages',
  'notif.category.chat.direct_messages.desc': 'New messages from people and groups',
  'notif.category.chat.orb_messages.label': 'ORB Messages',
  'notif.category.chat.orb_messages.desc': 'Proactive messages and suggestions from your AI assistant',
  'notif.category.chat.followup_reminders.label': 'Follow-up Reminders',
  'notif.category.chat.followup_reminders.desc': 'Reminders to continue conversations',
  'notif.category.calendar.event_reminders.label': 'Event Reminders',
  'notif.category.calendar.event_reminders.desc': 'Upcoming events and meetups starting soon',
  'notif.category.calendar.morning_briefing.label': 'Morning Briefing',
  'notif.category.calendar.morning_briefing.desc': 'Your daily morning summary and schedule',
  'notif.category.calendar.weekly_digest.label': 'Weekly Digest',
  'notif.category.calendar.weekly_digest.desc': 'Weekly community digest and activity summary',
  'notif.category.calendar.rsvp_updates.label': 'RSVP Updates',
  'notif.category.calendar.rsvp_updates.desc': 'Confirmations and updates about your RSVPs',
  'notif.category.community.group_activity.label': 'Group Activity',
  'notif.category.community.group_activity.desc': 'Activity in your groups — joins, milestones, invitations',
  'notif.category.community.meetups.label': 'Meetups',
  'notif.category.community.meetups.desc': 'Recommended meetups and meetup updates',
  'notif.category.community.live_rooms.label': 'Live Rooms',
  'notif.category.community.live_rooms.desc': 'Live room starting, invites, summaries, and recordings',
  'notif.category.community.connections_social.label': 'Connections & Social',
  'notif.category.community.connections_social.desc': 'New matches, connections, and social activity',
  // Priority of the Day banner (VTID-01947)
  'priority.absence_streak.named': '{name}, welcome back. Your diary streak paused at {streak} days — want to pick it up?',
  'priority.absence_streak': 'Welcome back. Your diary streak paused at {streak} days — want to pick it up?',
  'priority.absence.named.day': "{name}, it's been {days} day — glad you're back.",
  'priority.absence.named.days': "{name}, it's been {days} days — glad you're back.",
  'priority.absence.day': "It's been {days} day — glad you're back.",
  'priority.absence.days': "It's been {days} days — glad you're back.",
  'priority.overdue.one': '{count} journey activity is waiting from earlier. Want to tackle it now?',
  'priority.overdue.many': '{count} journey activities are waiting from earlier. Want to tackle one now?',
  'priority.goal_prosperity_idle': 'Your goal points at building freedom. One Business Hub check-in could move it today.',
  'priority.welcome_wave': 'You\'re in "{wave}" — {description}. Want a 2-minute walkthrough?',
  'priority.welcome_generic': 'Welcome to your longevity journey. Let me show you what we can do together.',
  'priority.open_recs.one': '{count} Autopilot action ready for you. Worth a look?',
  'priority.open_recs.many': '{count} Autopilot actions ready for you. Worth a look?',
  'priority.journey_day': 'Day {day} of your journey, in {wave}. Keep going.',
  'priority.greeting.morning.named': 'Good morning, {name}. Ready when you are.',
  'priority.greeting.morning': 'Good morning. Ready when you are.',
  'priority.greeting.afternoon.named': 'Good afternoon, {name}. Ready when you are.',
  'priority.greeting.afternoon': 'Good afternoon. Ready when you are.',
  'priority.greeting.evening.named': 'Good evening, {name}. Ready when you are.',
  'priority.greeting.evening': 'Good evening. Ready when you are.',
};

// Draft locales — start as a copy of EN; replace with native strings as they
// graduate to GA. The i18n-translate workflow already covers the frontend
// catalog; we'll wire the gateway catalog in once GA-readiness is decided.
const ES: LocaleCatalog = { ...EN };
const SR: LocaleCatalog = { ...EN };

const CATALOGS: Record<GatewayLocale, LocaleCatalog> = {
  de: DE,
  en: EN,
  es: ES,
  sr: SR,
};

/**
 * Resolve a key against the user's locale, substitute {placeholders}.
 * Falls back to DE (default), then EN, then the key itself.
 */
export function tt(
  key: GatewayI18nKey,
  locale: GatewayLocale | string | null | undefined,
  params?: Record<string, string | number>,
): string {
  const lc = normalizeLocale(locale);
  const value =
    CATALOGS[lc]?.[key] ?? CATALOGS[GATEWAY_DEFAULT_LOCALE][key] ?? CATALOGS.en[key] ?? key;
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
};

export function normalizeLocale(loc: string | null | undefined): GatewayLocale {
  if (!loc) return GATEWAY_DEFAULT_LOCALE;
  const lower = loc.toLowerCase().trim();
  // Exact language-name match takes priority over ISO-prefix heuristics so
  // word-form values resolve correctly regardless of their leading letters.
  const byName = LANGUAGE_NAME_TO_LOCALE[lower];
  if (byName) return byName;
  if (lower.startsWith('de')) return 'de';
  if (lower.startsWith('en')) return 'en';
  if (lower.startsWith('sr')) return 'sr';
  if (lower.startsWith('es')) return 'es';
  return GATEWAY_DEFAULT_LOCALE;
}
