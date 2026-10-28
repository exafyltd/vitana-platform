/**
 * Autopilot Wave Defaults — Static wave definitions for the journey system
 *
 * Each wave groups related recommendation templates and AP automations
 * into a phased journey the community user progresses through.
 */

export interface WaveTimeline {
  start_day: number;
  end_day: number;
}

export interface WaveDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  enabled: boolean;
  order: number;
  is_initiative: boolean;
  timeline: WaveTimeline;
  automation_ids: string[];
  recommendation_templates: string[];
}

export const DEFAULT_WAVE_CONFIG: WaveDefinition[] = [
  {
    id: 'wave-1',
    name: 'Getting Started',
    description: 'Set up your profile, meet Maxina, explore the community',
    icon: 'rocket',
    enabled: true,
    order: 1,
    is_initiative: false,
    timeline: { start_day: 0, end_day: 7 },
    automation_ids: [],
    recommendation_templates: [
      'onboarding_profile', 'onboarding_avatar', 'onboarding_explore',
      'onboarding_interests', 'onboarding_maxina', 'onboarding_diary_day0',
      'onboarding_health', 'onboarding_discover_matches',
    ],
  },
  {
    id: 'wave-2',
    name: 'Daily Anchors',
    description: 'Build daily habits — diary, matches, meetups',
    icon: 'sun',
    enabled: true,
    order: 2,
    is_initiative: false,
    timeline: { start_day: 1, end_day: 14 },
    automation_ids: ['AP-0501', 'AP-0505', 'AP-0506'],
    recommendation_templates: [
      'onboarding_diary', 'onboarding_matches', 'onboarding_group',
      'engage_matches', 'engage_meetup', 'engage_health',
    ],
  },
  {
    id: 'wave-3',
    name: 'Deepening Connections',
    description: 'Deepen connections, set goals, invite friends',
    icon: 'heart',
    enabled: true,
    order: 3,
    is_initiative: false,
    timeline: { start_day: 7, end_day: 30 },
    automation_ids: ['AP-0101', 'AP-0102', 'AP-0103', 'AP-0303', 'AP-0507'],
    recommendation_templates: [
      'deepen_connection', 'set_goal', 'invite_friend',
    ],
  },
  {
    id: 'wave-4',
    name: 'Health Intelligence',
    description: 'Health tracking, biomarker trends, Vitana Index',
    icon: 'activity',
    enabled: true,
    order: 4,
    is_initiative: false,
    timeline: { start_day: 14, end_day: 60 },
    automation_ids: ['AP-0607', 'AP-0608', 'AP-0609', 'AP-0610', 'AP-0611', 'AP-0614'],
    recommendation_templates: [
      'share_expertise', 'start_streak', 'streak_celebration',
    ],
  },
  {
    id: 'wave-5',
    name: 'Insight Moments',
    description: 'Weekly reports, pattern reveals, milestones',
    icon: 'lightbulb',
    enabled: true,
    order: 5,
    is_initiative: false,
    timeline: { start_day: 30, end_day: 60 },
    automation_ids: ['AP-0502', 'AP-0504', 'AP-0611'],
    recommendation_templates: [
      'explore_content', 'try_live_room', 'create_live_room',
    ],
  },
  {
    id: 'wave-6',
    name: 'Recommendations & Discovery',
    description: 'Products, services, professionals tailored to you',
    icon: 'compass',
    enabled: true,
    order: 6,
    is_initiative: false,
    timeline: { start_day: 30, end_day: 90 },
    automation_ids: ['AP-0612', 'AP-0615', 'AP-1101', 'AP-1102', 'AP-1103', 'AP-1104'],
    recommendation_templates: [
      'mentor_newcomer', 'explore_marketplace',
    ],
  },
  {
    id: 'wave-7',
    name: 'Events & Meetups',
    description: 'Let Vitana create events, send invitations, organize meetups',
    icon: 'calendar',
    enabled: false,
    order: 7,
    is_initiative: true,
    timeline: { start_day: 14, end_day: 90 },
    automation_ids: ['AP-1401', 'AP-1402', 'AP-1403', 'AP-1404', 'AP-1405'],
    recommendation_templates: [
      'initiative_event_create', 'initiative_calendar_sync',
      'initiative_auto_invite', 'initiative_event_discover',
      'initiative_meetup_organize',
    ],
  },
  {
    id: 'wave-8',
    name: 'Business Opportunity',
    description: 'Marketplace gaps, revenue opportunities, business coaching',
    icon: 'trending-up',
    enabled: false,
    order: 8,
    is_initiative: true,
    timeline: { start_day: 30, end_day: 90 },
    automation_ids: ['AP-1501', 'AP-1502', 'AP-1503', 'AP-1504', 'AP-1505'],
    recommendation_templates: [
      'initiative_gap_detection', 'initiative_revenue_alert',
      'initiative_demand_match', 'initiative_biz_coach',
      'initiative_income_tips',
    ],
  },
  {
    id: 'wave-9',
    name: 'Health Action',
    description: 'Lab tests, screenings, exercise, supplements — take action',
    icon: 'heart-pulse',
    enabled: false,
    order: 9,
    is_initiative: true,
    timeline: { start_day: 14, end_day: 90 },
    automation_ids: ['AP-1601', 'AP-1602', 'AP-1603', 'AP-1604', 'AP-1605'],
    recommendation_templates: [
      'initiative_lab_order', 'initiative_screening',
      'initiative_health_nudge', 'initiative_exercise',
      'initiative_supplement_reorder',
    ],
  },
];

/** Lookup a wave by ID */
export function getWaveById(id: string): WaveDefinition | undefined {
  return DEFAULT_WAVE_CONFIG.find(w => w.id === id);
}

/** Get the wave that contains a given recommendation template */
export function getWaveForTemplate(templateKey: string): WaveDefinition | undefined {
  return DEFAULT_WAVE_CONFIG.find(w => w.recommendation_templates.includes(templateKey));
}

/** Build a map from template key → wave id for fast lookups */
export function buildTemplateToWaveMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const wave of DEFAULT_WAVE_CONFIG) {
    for (const tpl of wave.recommendation_templates) {
      map.set(tpl, wave.id);
    }
  }
  return map;
}
