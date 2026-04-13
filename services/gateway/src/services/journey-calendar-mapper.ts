/**
 * Intelligent Calendar — Phase 5: 90-Day Default Calendar Package
 *
 * Maps the 9-wave autopilot journey into concrete calendar events that
 * are pre-populated at user registration. The calendar is never empty.
 *
 * When the user first opens the calendar or asks the assistant "What should I do?",
 * the journey events are already there as the default starting point.
 */

import { DEFAULT_WAVE_CONFIG } from './wave-defaults';
import { bulkCreateCalendarEvents, getEventsBySourceRef } from './calendar-service';
import { CreateCalendarEventInput, CreateCalendarEventSchema } from '../types/calendar';
import { emitOasisEvent } from './oasis-event-service';

const LOG_PREFIX = '[JourneyCalendar]';

// =============================================================================
// Time slot mapping
// =============================================================================

type TimeSlot = 'morning' | 'afternoon' | 'evening';

const TIME_SLOT_HOURS: Record<TimeSlot, number> = {
  morning: 8,
  afternoon: 14,
  evening: 20,
};

// =============================================================================
// Default Calendar Package — maps wave templates to concrete events
// =============================================================================

interface JourneyEventTemplate {
  /** Which wave recommendation template this maps to */
  template_key: string;
  /** Day offset from registration date */
  day: number;
  /** Preferred time of day */
  time_slot: TimeSlot;
  /** Duration in minutes */
  duration_minutes: number;
  /** Calendar event type */
  event_type: string;
  /** Wellness tags for nudge matching */
  wellness_tags: string[];
  /** Default title (English fallback) */
  title_en: string;
  /** Default description */
  description_en: string;
}

const DEFAULT_CALENDAR_PACKAGE: JourneyEventTemplate[] = [
  // ── Wave 1: Getting Started (Days 0-7) ──
  { template_key: 'onboarding_profile', day: 0, time_slot: 'morning', duration_minutes: 10, event_type: 'autopilot', wellness_tags: ['onboarding'], title_en: 'Complete your profile', description_en: 'A complete profile helps us understand you and give better recommendations.' },
  { template_key: 'onboarding_avatar', day: 0, time_slot: 'morning', duration_minutes: 5, event_type: 'autopilot', wellness_tags: ['onboarding'], title_en: 'Add your photo', description_en: 'A profile photo helps others recognize you.' },
  { template_key: 'onboarding_explore', day: 0, time_slot: 'afternoon', duration_minutes: 10, event_type: 'autopilot', wellness_tags: ['social', 'onboarding'], title_en: 'Explore your community', description_en: 'See who is nearby and which groups exist.' },
  { template_key: 'onboarding_interests', day: 0, time_slot: 'afternoon', duration_minutes: 5, event_type: 'autopilot', wellness_tags: ['onboarding'], title_en: 'Share your interests', description_en: 'Tell us what you enjoy so we can connect you.' },
  { template_key: 'onboarding_maxina', day: 1, time_slot: 'morning', duration_minutes: 10, event_type: 'autopilot', wellness_tags: ['onboarding', 'social'], title_en: 'Say hello to Maxina', description_en: 'Your AI companion is ready to get to know you.' },
  { template_key: 'onboarding_diary_day0', day: 1, time_slot: 'evening', duration_minutes: 10, event_type: 'autopilot', wellness_tags: ['mindfulness', 'onboarding'], title_en: 'Write your first diary entry', description_en: 'Start your well-being journey by recording how you feel today.' },
  { template_key: 'onboarding_health', day: 2, time_slot: 'morning', duration_minutes: 10, event_type: 'autopilot', wellness_tags: ['health-check'], title_en: 'Check your health status', description_en: 'Take a quick look at your Vitana health index.' },
  { template_key: 'onboarding_discover_matches', day: 2, time_slot: 'afternoon', duration_minutes: 10, event_type: 'autopilot', wellness_tags: ['social'], title_en: 'Discover your matches', description_en: 'See who the community has matched you with.' },

  // ── Wave 2: Daily Anchors (Days 1-14) ──
  { template_key: 'onboarding_diary', day: 3, time_slot: 'evening', duration_minutes: 10, event_type: 'autopilot', wellness_tags: ['mindfulness'], title_en: 'Daily diary entry', description_en: 'Record how you feel today. Maxina can help.' },
  { template_key: 'onboarding_matches', day: 4, time_slot: 'morning', duration_minutes: 10, event_type: 'autopilot', wellness_tags: ['social'], title_en: 'Check your matches', description_en: 'We found people who match you. Take a look!' },
  { template_key: 'onboarding_group', day: 5, time_slot: 'afternoon', duration_minutes: 10, event_type: 'autopilot', wellness_tags: ['social', 'community'], title_en: 'Join a group', description_en: 'Groups connect you with like-minded people.' },
  { template_key: 'engage_matches', day: 7, time_slot: 'morning', duration_minutes: 10, event_type: 'autopilot', wellness_tags: ['social'], title_en: 'Respond to your matches', description_en: 'You have pending match suggestions. Connect with someone!' },
  { template_key: 'engage_meetup', day: 8, time_slot: 'afternoon', duration_minutes: 60, event_type: 'community', wellness_tags: ['social', 'community'], title_en: 'Attend a meetup', description_en: 'Real encounters strengthen the community.' },
  { template_key: 'engage_health', day: 10, time_slot: 'morning', duration_minutes: 15, event_type: 'health', wellness_tags: ['health-check'], title_en: 'Check your health scores', description_en: 'Your Vitana Index gives you an overview of your well-being.' },

  // ── Wave 3: Deepening Connections (Days 7-30) ──
  { template_key: 'deepen_connection', day: 14, time_slot: 'afternoon', duration_minutes: 30, event_type: 'personal', wellness_tags: ['social'], title_en: 'Deepen a connection', description_en: 'Message one of your connections. Together is better!' },
  { template_key: 'set_goal', day: 16, time_slot: 'morning', duration_minutes: 15, event_type: 'health', wellness_tags: ['health', 'mindfulness'], title_en: 'Set a health goal', description_en: 'Define a personal goal and let Maxina guide you.' },
  { template_key: 'invite_friend', day: 21, time_slot: 'afternoon', duration_minutes: 10, event_type: 'personal', wellness_tags: ['social', 'community'], title_en: 'Invite a friend', description_en: 'Share Vitana with someone who could benefit.' },

  // ── Wave 4: Health Intelligence (Days 14-60) ──
  { template_key: 'share_expertise', day: 18, time_slot: 'afternoon', duration_minutes: 20, event_type: 'community', wellness_tags: ['social', 'learning'], title_en: 'Share your knowledge', description_en: 'You have experience that can help others.' },
  { template_key: 'start_streak', day: 20, time_slot: 'morning', duration_minutes: 15, event_type: 'health', wellness_tags: ['wellness', 'movement'], title_en: 'Start a wellness streak', description_en: 'Consistency brings results. Begin a 7-day challenge!' },

  // ── Wave 5: Insight Moments (Days 30-60) ──
  { template_key: 'explore_content', day: 30, time_slot: 'afternoon', duration_minutes: 15, event_type: 'personal', wellness_tags: ['learning'], title_en: 'Explore wellness content', description_en: 'Discover articles, podcasts, and videos curated for you.' },
  { template_key: 'try_live_room', day: 35, time_slot: 'evening', duration_minutes: 30, event_type: 'community', wellness_tags: ['social', 'learning'], title_en: 'Join a live room', description_en: 'Join a live discussion on a topic you care about.' },
  { template_key: 'create_live_room', day: 45, time_slot: 'evening', duration_minutes: 30, event_type: 'community', wellness_tags: ['social', 'leadership'], title_en: 'Host a live discussion', description_en: 'Lead a conversation on a topic you know well.' },

  // ── Wave 6: Recommendations & Discovery (Days 30-90) ──
  { template_key: 'mentor_newcomer', day: 40, time_slot: 'afternoon', duration_minutes: 30, event_type: 'community', wellness_tags: ['social', 'leadership'], title_en: 'Mentor a newcomer', description_en: 'Your experience is valuable. Help new members get started.' },
  { template_key: 'explore_marketplace', day: 50, time_slot: 'morning', duration_minutes: 15, event_type: 'personal', wellness_tags: ['discovery'], title_en: 'Explore the marketplace', description_en: 'Discover products and services tailored to your wellness goals.' },
];

// Wave milestone markers (full-day events)
interface WaveMilestone {
  wave_id: string;
  wave_name: string;
  day: number;
  type: 'start' | 'checkpoint';
}

function buildWaveMilestones(): WaveMilestone[] {
  const milestones: WaveMilestone[] = [];
  for (const wave of DEFAULT_WAVE_CONFIG) {
    if (!wave.enabled) continue;
    milestones.push({
      wave_id: wave.id,
      wave_name: wave.name,
      day: wave.timeline.start_day,
      type: 'start',
    });
    milestones.push({
      wave_id: wave.id,
      wave_name: wave.name,
      day: wave.timeline.end_day,
      type: 'checkpoint',
    });
  }
  return milestones;
}

// =============================================================================
// Journey Calendar Initialization
// =============================================================================

export async function initializeJourneyCalendar(
  userId: string,
  tenantId: string,
  startDate: Date = new Date(),
  language: string = 'en',
): Promise<{ ok: boolean; events_created: number; error?: string }> {
  console.log(`${LOG_PREFIX} Initializing 90-day journey calendar for user ${userId.slice(0, 8)}... (language: ${language})`);

  // Idempotency check: skip if journey events already exist
  const existing = await getEventsBySourceRef(userId, 'journey-calendar-init');
  if (existing.length > 0) {
    console.log(`${LOG_PREFIX} Journey calendar already initialized (${existing.length} events). Skipping.`);
    return { ok: true, events_created: 0 };
  }

  const events: CreateCalendarEventInput[] = [];

  // 1. Build task events from the default package
  for (const template of DEFAULT_CALENDAR_PACKAGE) {
    const eventDate = new Date(startDate);
    eventDate.setDate(eventDate.getDate() + template.day);
    eventDate.setHours(TIME_SLOT_HOURS[template.time_slot], 0, 0, 0);

    const endDate = new Date(eventDate);
    endDate.setMinutes(endDate.getMinutes() + template.duration_minutes);

    events.push({
      title: template.title_en,
      description: template.description_en,
      start_time: eventDate.toISOString(),
      end_time: endDate.toISOString(),
      event_type: template.event_type,
      status: 'pending',
      priority: 'medium',
      role_context: 'community',
      source_type: 'journey',
      source_ref_id: template.template_key,
      source_ref_type: 'journey_task',
      priority_score: 50,
      wellness_tags: template.wellness_tags,
      metadata: { wave_template: template.template_key, day_offset: template.day, time_slot: template.time_slot },
    } as any);
  }

  // 2. Build wave milestone markers
  const milestones = buildWaveMilestones();
  for (const ms of milestones) {
    const msDate = new Date(startDate);
    msDate.setDate(msDate.getDate() + ms.day);
    msDate.setHours(0, 0, 0, 0);

    const msEnd = new Date(msDate);
    msEnd.setHours(23, 59, 59, 999);

    const title = ms.type === 'start'
      ? `${ms.wave_name} begins`
      : `${ms.wave_name} checkpoint`;

    events.push({
      title,
      description: `Journey milestone: ${ms.wave_name} (${ms.type})`,
      start_time: msDate.toISOString(),
      end_time: msEnd.toISOString(),
      event_type: 'journey_milestone',
      status: ms.type === 'start' ? 'confirmed' : 'pending',
      priority: 'medium',
      role_context: 'community',
      source_type: 'journey',
      source_ref_id: ms.type === 'start' ? `${ms.wave_id}-start` : `${ms.wave_id}-checkpoint`,
      source_ref_type: 'wave_milestone',
      priority_score: 60,
      wellness_tags: [],
      metadata: { wave_id: ms.wave_id, wave_name: ms.wave_name, milestone_type: ms.type },
    } as any);
  }

  // 3. Add a sentinel event for idempotency
  events.push({
    title: '90-Day Journey Started',
    description: 'Your personalized wellness journey begins today.',
    start_time: startDate.toISOString(),
    end_time: new Date(startDate.getTime() + 60000).toISOString(),
    event_type: 'journey_milestone',
    status: 'confirmed',
    priority: 'high',
    role_context: 'community',
    source_type: 'journey',
    source_ref_id: 'journey-calendar-init',
    source_ref_type: 'journey_sentinel',
    priority_score: 100,
    wellness_tags: ['onboarding'],
    metadata: { initialized_at: new Date().toISOString(), language, total_events: events.length },
  } as any);

  // 4. Bulk create all events
  const created = await bulkCreateCalendarEvents(userId, events);

  console.log(`${LOG_PREFIX} Created ${created.length}/${events.length} journey events for user ${userId.slice(0, 8)}...`);

  emitOasisEvent({
    vtid: 'SYSTEM',
    type: 'calendar.journey.initialized' as any,
    source: 'journey-calendar-mapper',
    status: 'info',
    message: `90-day journey calendar initialized: ${created.length} events`,
    payload: { user_id: userId, tenant_id: tenantId, events_created: created.length, language },
  }).catch(() => {});

  return { ok: true, events_created: created.length };
}

/**
 * Get the user's current journey stage based on registration date.
 */
export function getJourneyStage(registrationDate: Date): {
  day_number: number;
  wave_name: string;
  wave_id: string;
  total_days: number;
} | null {
  const dayNumber = Math.floor((Date.now() - registrationDate.getTime()) / (24 * 60 * 60 * 1000));
  if (dayNumber < 0 || dayNumber > 90) return null;

  // Find the active wave for this day
  for (const wave of DEFAULT_WAVE_CONFIG) {
    if (!wave.enabled) continue;
    if (dayNumber >= wave.timeline.start_day && dayNumber <= wave.timeline.end_day) {
      return {
        day_number: dayNumber,
        wave_name: wave.name,
        wave_id: wave.id,
        total_days: 90,
      };
    }
  }

  return { day_number: dayNumber, wave_name: 'Discovery', wave_id: 'wave-6', total_days: 90 };
}
