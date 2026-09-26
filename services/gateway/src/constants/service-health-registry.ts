/**
 * VTID-04087 — the single source of truth for the Command Hub Service
 * Health panel's endpoint list.
 *
 * Before this file, the 55-entry list lived only as a hardcoded
 * `healthEndpoints` array inside `fetchServiceHealth()` in the Command Hub's
 * static `app.js` — a frontend-only asset with no server-side counterpart,
 * so a new health route could ship and never appear on the panel unless
 * someone remembered to hand-edit the array too. This module is now the
 * canonical list; the gateway serves it via `GET /api/v1/admin/health-registry`
 * (see `routes/admin-health.ts`), and `app.js` fetches it at runtime,
 * falling back to its own last-known-good copy only if that fetch fails.
 *
 * Keep this list and the frontend's fallback copy in sync when adding or
 * removing a health check — the frontend fallback exists purely so the
 * panel still renders something if the registry route itself is
 * unreachable, not as a second place to maintain routine changes.
 */
export interface ServiceHealthEndpoint {
  name: string;
  url: string;
  group: string;
}

/**
 * VTID-04661 — display order of the panel's groups. The panel used to carry
 * its own hardcoded copy of this list and silently dropped any check whose
 * group was not in it — which is how 'Screen Load Time' ('Frontend &
 * Performance') was counted in "54/55" but never drawn. The panel now draws
 * these first, in this order, and then every other group it finds, so an
 * entry can never be counted but hidden. A test fails if a registry entry
 * names a group that is not listed here.
 */
export const SERVICE_HEALTH_GROUPS: string[] = [
  'Core Infrastructure',
  'AI & Assistant',
  'Autopilot',
  'Automation & Scheduling',
  'Community & Social',
  'Domain & Context',
  'Visual & VTID',
  'Frontend & Performance',
];

export const SERVICE_HEALTH_REGISTRY: ServiceHealthEndpoint[] = [
  { name: 'Gateway', url: '/health', group: 'Core Infrastructure' },
  { name: 'Gateway Alive', url: '/alive', group: 'Core Infrastructure' },
  { name: 'Auth', url: '/api/v1/auth/health', group: 'Core Infrastructure' },
  { name: 'CI/CD', url: '/api/v1/cicd/health', group: 'Core Infrastructure' },
  { name: 'Execute Runner', url: '/api/v1/execute/health', group: 'Core Infrastructure' },
  { name: 'Operator', url: '/api/v1/operator/health', group: 'Core Infrastructure' },
  { name: 'Operator Deploys', url: '/api/v1/operator/deployments/health', group: 'Core Infrastructure' },
  { name: 'Telemetry', url: '/api/v1/telemetry/health', group: 'Core Infrastructure' },
  { name: 'Events', url: '/events/health', group: 'Core Infrastructure' },
  { name: 'Command Hub UI', url: '/command-hub/health', group: 'Core Infrastructure' },
  { name: 'Assistant', url: '/api/v1/assistant/health', group: 'AI & Assistant' },
  { name: 'Knowledge Hub', url: '/api/v1/assistant/knowledge/health', group: 'AI & Assistant' },
  { name: 'ORB Live', url: '/api/v1/orb/health', group: 'AI & Assistant' },
  { name: 'Voice Lab', url: '/api/v1/voice-lab/health', group: 'AI & Assistant' },
  { name: 'Conversation', url: '/api/v1/conversation/health', group: 'AI & Assistant' },
  { name: 'Conversation Tools', url: '/api/v1/conversation/tool-health', group: 'AI & Assistant' },
  { name: 'Autopilot', url: '/api/v1/autopilot/health', group: 'Autopilot' },
  { name: 'Autopilot Pipeline', url: '/api/v1/autopilot/pipeline/health', group: 'Autopilot' },
  { name: 'Autopilot Prompts', url: '/api/v1/autopilot/prompts/health', group: 'Autopilot' },
  { name: 'Recommendations', url: '/api/v1/autopilot/recommendations/health', group: 'Autopilot' },
  { name: 'Automations', url: '/api/v1/automations/health', group: 'Automation & Scheduling' },
  { name: 'Rec. Inbox', url: '/api/v1/recommendations/health', group: 'Automation & Scheduling' },
  { name: 'Memory', url: '/api/v1/memory/health', group: 'Automation & Scheduling' },
  { name: 'Semantic Memory', url: '/api/v1/memory/semantic/health', group: 'Automation & Scheduling' },
  { name: 'Diary', url: '/api/v1/diary/health', group: 'Automation & Scheduling' },
  { name: 'Health Capacity', url: '/api/v1/capacity/health', group: 'Automation & Scheduling' },
  { name: 'Scheduler', url: '/api/v1/scheduler/health', group: 'Automation & Scheduling' },
  { name: 'Sched. Notifications', url: '/api/v1/scheduled-notifications/health', group: 'Automation & Scheduling' },
  { name: 'Email Intake', url: '/api/v1/intake/email/health', group: 'Automation & Scheduling' },
  { name: 'Community', url: '/api/v1/community/health', group: 'Community & Social' },
  { name: 'Relationships', url: '/api/v1/relationships/health', group: 'Community & Social' },
  { name: 'Matchmaking', url: '/api/v1/match/health', group: 'Community & Social' },
  { name: 'Personalization', url: '/api/v1/personalization/health', group: 'Community & Social' },
  { name: 'Live Rooms', url: '/api/v1/live/health', group: 'Community & Social' },
  { name: 'Social Context', url: '/api/v1/social/health', group: 'Community & Social' },
  { name: 'Social Connect', url: '/api/v1/social-accounts/health', group: 'Community & Social' },
  { name: 'Social Alignment', url: '/api/v1/alignment/health', group: 'Community & Social' },
  { name: 'Topics', url: '/api/v1/topics/health', group: 'Community & Social' },
  { name: 'Domain Routing', url: '/api/v1/routing/health', group: 'Domain & Context' },
  { name: 'Locations', url: '/api/v1/locations/health', group: 'Domain & Context' },
  { name: 'Offers', url: '/api/v1/offers/health', group: 'Domain & Context' },
  { name: 'Feedback', url: '/api/v1/feedback/health', group: 'Domain & Context' },
  { name: 'Voice Feedback', url: '/api/v1/voice-feedback/health', group: 'Domain & Context' },
  { name: 'Situational', url: '/api/v1/situational/health', group: 'Domain & Context' },
  { name: 'Availability', url: '/api/v1/availability/health', group: 'Domain & Context' },
  { name: 'Env. Mobility', url: '/api/v1/context/mobility/health', group: 'Domain & Context' },
  { name: 'User Preferences', url: '/api/v1/user-preferences/health', group: 'Domain & Context' },
  { name: 'Taste Alignment', url: '/api/v1/taste-alignment/health', group: 'Domain & Context' },
  { name: 'Overload Detection', url: '/api/v1/overload/health', group: 'Domain & Context' },
  { name: 'Risk Mitigation', url: '/api/v1/mitigation/health', group: 'Domain & Context' },
  { name: 'Opportunities', url: '/api/v1/opportunities/health', group: 'Domain & Context' },
  { name: 'Visual Interactive', url: '/api/v1/visual/health', group: 'Visual & VTID' },
  { name: 'VTID Terminalize', url: '/api/v1/oasis/vtid/terminalize/health', group: 'Visual & VTID' },
  { name: 'VTID', url: '/api/v1/vtid/health', group: 'Visual & VTID' },
  // DEV-COMHU-03401 / VTID-SCREEN-LOAD-01: standard basic test — scheduled
  // Playwright run (SCREEN-LOAD-TIMING.yml) measures mobile screen load time
  // against staging and reports here. 'down' means a screen failed to load
  // or nothing has reported in 12h; 'degraded' means it's slow (p75 over
  // budget) or the last report is 3-12h old — GitHub runs the 30-minute
  // cron every 3-5h in practice (VTID-04661).
  { name: 'Screen Load Time', url: '/api/v1/frontend/screen-load/health', group: 'Frontend & Performance' },
];
