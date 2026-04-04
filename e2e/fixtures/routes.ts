import type { UserRole } from './test-users';

// ─── Public routes (no auth required) ───────────────────────────────────────
export const PUBLIC_ROUTES: string[] = [
  '/',
  '/auth',
  '/auth/confirmed',
  '/maxina/confirmed',
  '/alkalma/confirmed',
  '/earthlinks/confirmed',
  '/community/confirmed',
  '/reset-password',
  '/privacy',
  '/terms',
  '/delete-account',
  '/maxina_support',
  '/redeem',
  '/logout',
  '/tickets/success',
  '/packages/success',
  '/tickets/demo',
  '/exafy-admin',
  '/maxina',
  '/alkalma',
  '/earthlinks',
  '/community',
  '/dev/login',
];

// ─── Community base routes (AuthGuard, any authenticated user) ──────────────
export const COMMUNITY_BASE_ROUTES: string[] = [
  // Home
  '/home',
  '/home/context',
  '/home/actions',
  '/home/matches',
  '/home/aifeed',
  // Discover
  '/discover',
  '/discover/ai-picks',
  '/discover/supplements',
  '/discover/wellness-services',
  '/discover/doctors-coaches',
  '/discover/deals-offers',
  '/discover/orders',
  // Cart / Checkout
  '/cart',
  '/checkout/success',
  '/creator/onboarded',
  '/my-tickets',
  '/daily-diary',
  // Health
  '/health',
  '/health/pillars',
  '/health/services-hub',
  '/health/conditions',
  '/health/education',
  '/health/my-biology',
  '/health/plans',
  // Community
  '/comm',
  '/comm/groups',
  '/comm/events-meetups',
  '/comm/live-rooms',
  '/comm/media-hub',
  // Business
  '/business',
  // AI
  '/ai',
  '/ai/insights',
  '/ai/recommendations',
  '/ai/daily-summary',
  '/ai/companion',
  // Inbox
  '/inbox',
  '/inbox/archived',
  '/inbox/reminder',
  '/inbox/inspiration',
  // Settings
  '/settings',
  '/settings/privacy',
  '/settings/notifications',
  '/settings/preferences',
  '/settings/connected-apps',
  '/settings/tenant-role',
  '/settings/billing',
  '/settings/support',
  '/settings/social',
  // Assistant / Profile / Other
  '/assistant',
  '/me/profile',
  '/search',
  '/autopilot',
  '/invite',
  // Wallet
  '/wallet',
  '/wallet/balance',
  '/wallet/subscriptions',
  '/wallet/rewards',
  // Sharing
  '/sharing',
  '/sharing/campaigns',
  '/sharing/distribution',
  '/sharing/data-consent',
  // Memory
  '/memory',
  '/memory/timeline',
  '/memory/diary',
  '/memory/recall',
  '/memory/permissions',
];

// ─── Role-specific routes ───────────────────────────────────────────────────

export const PATIENT_ROUTES: string[] = [
  '/patient/dashboard',
  '/patient/health',
  '/patient/appointments',
  '/patient/results',
  '/patient/care-team',
  '/patient/goals',
  '/patient/insurance',
  '/patient/notifications',
];

export const PROFESSIONAL_ROUTES: string[] = [
  '/professional/dashboard',
  '/professional/patients',
  '/professional/schedule',
  '/professional/tools',
  '/professional/referrals',
  '/professional/billing',
  '/professional/profile',
  '/professional/education',
];

export const STAFF_ROUTES: string[] = [
  '/staff/dashboard',
  '/staff/queue',
  '/staff/tasks',
  '/staff/schedule',
  '/staff/reports',
  '/staff/communications',
  '/staff/tools',
  '/staff/time',
];

export const ADMIN_ROUTES: string[] = [
  // Dashboard
  '/admin/dashboard',
  '/admin/dashboard/health',
  '/admin/dashboard/activity',
  // Users & Growth
  '/admin/users',
  '/admin/users/funnel',
  '/admin/users/invitations',
  '/admin/users/roles',
  // Notifications
  '/admin/notifications',
  '/admin/notifications/sent',
  '/admin/notifications/preferences',
  // Community
  '/admin/community',
  '/admin/community/meetups',
  '/admin/community/invitations',
  '/admin/community/moderation',
  // Live Rooms
  '/admin/live',
  '/admin/live/rooms',
  '/admin/live/sessions',
  '/admin/live/attendance',
  // Content
  '/admin/content',
  '/admin/content/videos',
  '/admin/content/podcasts',
  '/admin/content/music',
  // Intelligence
  '/admin/intelligence',
  '/admin/intelligence/embeddings',
  '/admin/intelligence/signals',
  '/admin/intelligence/relationships',
  // System
  '/admin/system',
  '/admin/system/tenants',
  '/admin/system/creators',
  '/admin/system/bootstrap',
  // Audit & Logs
  '/admin/audit',
  '/admin/audit/users',
  '/admin/audit/apis',
  '/admin/audit/security',
  // Other
  '/admin/init-events',
];

// ─── Dev Hub routes (DevAuthGuard) ──────────────────────────────────────────

export const DEV_ROUTES: string[] = [
  '/dev/dashboard',
  '/dev/dashboard/ai-feed',
  '/dev/dashboard/alerts',
  '/dev/dashboard/health',
  '/dev/command',
  '/dev/command/approvals',
  '/dev/command/history',
  '/dev/command/compose',
  '/dev/command/tasks',
  '/dev/command/autopilot-runs',
  '/dev/agents',
  '/dev/agents/worker',
  '/dev/agents/validator',
  '/dev/agents/qa-test',
  '/dev/agents/crew-template',
  '/dev/pipelines',
  '/dev/pipelines/tests',
  '/dev/pipelines/canary',
  '/dev/pipelines/rollbacks',
  '/dev/oasis',
  '/dev/oasis/state',
  '/dev/oasis/ledger',
  '/dev/oasis/policies',
  '/dev/vtid',
  '/dev/vtid/issue',
  '/dev/vtid/analytics',
  '/dev/vtid/search',
  '/dev/gateway',
  '/dev/gateway/requests',
  '/dev/gateway/mobile',
  '/dev/gateway/webhooks',
  '/dev/cicd',
  '/dev/cicd/runs',
  '/dev/cicd/artifacts',
  '/dev/cicd/matrix',
  '/dev/observability',
  '/dev/observability/traces',
  '/dev/observability/metrics',
  '/dev/observability/costs',
  '/dev/settings',
  '/dev/settings/auth',
  '/dev/settings/flags',
  '/dev/settings/tenants',
  '/dev/docs',
  '/dev/docs/catalogs',
  '/dev/docs/screen-lists',
  '/dev/docs/frontpages',
  '/dev/docs/role-views',
];

// ─── Legacy redirect map (old path → expected new path) ─────────────────────

export const REDIRECT_MAP: Record<string, string> = {
  // Auth
  '/login': '/auth',
  '/register': '/auth',
  // Dashboard → Home
  '/dashboard': '/home',
  '/dashboard/context': '/home/context',
  '/dashboard/actions': '/home/actions',
  '/dashboard/matches': '/home/matches',
  '/dashboard/aifeed': '/home/aifeed',
  // Health legacy
  '/health/biomarker-results': '/health/my-biology',
  // Community legacy → /comm
  '/community/groups': '/comm/groups',
  '/community/feed': '/comm/events-meetups',
  '/community/events': '/comm/events-meetups',
  '/community/meetups': '/comm/events-meetups',
  '/community/live-rooms': '/comm/live-rooms',
  '/community/media-hub': '/comm/media-hub',
  '/community/my-business': '/business',
  '/comm/my-business': '/business',
  '/comm/my-groups': '/comm/groups',
  '/comm/feed': '/comm/events-meetups',
  '/comm/events': '/comm/events-meetups',
  '/comm/meetups': '/comm/events-meetups',
  // Messages → Inbox
  '/messages': '/inbox',
  // Settings legacy
  '/settings/autopilot': '/assistant',
  '/settings/voice-ai': '/assistant',
  // Profile
  '/profile': '/me/profile',
  // Admin legacy
  '/admin': '/admin/dashboard',
  '/admin/user-management': '/admin/users',
  '/admin/user-management/staff': '/admin/users/roles',
  '/admin/user-management/audit': '/admin/audit/users',
  '/admin/tenant-management': '/admin/system/tenants',
  '/admin/system-health': '/admin/dashboard/health',
  '/admin/monitoring/reports': '/admin/audit',
  '/admin/monitoring/notifications': '/admin/notifications',
  '/admin/monitoring/apis': '/admin/audit/apis',
  '/admin/ai-assistant': '/admin/intelligence',
  '/admin/automation': '/admin/intelligence',
  '/admin/live-stream': '/admin/live',
  '/admin/media': '/admin/content',
  '/admin/bootstrap': '/admin/system/bootstrap',
};

// ─── Routes that require auth guard redirect testing ────────────────────────
// A subset of critical protected routes to test unauthenticated access
export const AUTH_GUARD_TEST_ROUTES: string[] = [
  '/home',
  '/discover',
  '/health',
  '/comm',
  '/inbox',
  '/settings',
  '/wallet',
  '/memory',
  '/ai',
  '/admin/dashboard',
  '/patient/dashboard',
  '/professional/dashboard',
  '/staff/dashboard',
];

// ─── Routes to test role guard (community user should NOT access) ───────────
export const ROLE_GUARD_TEST_ROUTES: Record<string, string[]> = {
  admin: ['/admin/dashboard', '/admin/users', '/admin/system', '/admin/audit'],
  patient: ['/patient/dashboard', '/patient/health', '/patient/appointments'],
  professional: ['/professional/dashboard', '/professional/patients'],
  staff: ['/staff/dashboard', '/staff/queue', '/staff/tasks'],
};

// ─── Command Hub routes (87 screens) ────────────────────────────────────────

const ALL_HUB_MODULES = [
  { module: 'overview', tabs: ['system-overview', 'live-metrics', 'recent-events', 'errors-violations', 'release-feed'] },
  { module: 'admin', tabs: ['users', 'permissions', 'tenants', 'content-moderation', 'identity-access', 'analytics'] },
  { module: 'operator', tabs: ['dashboard', 'task-queue', 'event-stream', 'deployments', 'runbook'] },
  { module: 'command-hub', tabs: ['tasks', 'live-console', 'events', 'vtids', 'approvals'] },
  { module: 'governance', tabs: ['rules', 'categories', 'evaluations', 'violations', 'history', 'proposals'] },
  { module: 'agents', tabs: ['registered-agents', 'skills', 'pipelines', 'memory', 'telemetry'] },
  { module: 'workflows', tabs: ['workflow-list', 'triggers', 'actions', 'schedules', 'history'] },
  { module: 'oasis', tabs: ['events', 'vtid-ledger', 'entities', 'streams', 'command-log'] },
  { module: 'databases', tabs: ['supabase', 'vectors', 'cache', 'analytics', 'clusters'] },
  { module: 'infrastructure', tabs: ['services', 'health', 'self-healing', 'deployments', 'logs', 'config'] },
  { module: 'security-dev', tabs: ['policies', 'roles', 'keys-secrets', 'audit-log', 'rls-access'] },
  { module: 'integrations-tools', tabs: ['mcp-connectors', 'llm-providers', 'apis', 'tools', 'service-mesh'] },
  { module: 'diagnostics', tabs: ['health-checks', 'latency', 'errors', 'sse', 'debug-panel', 'voice-lab'] },
  { module: 'models-evaluations', tabs: ['models', 'evaluations', 'benchmarks', 'routing', 'playground'] },
  { module: 'testing-qa', tabs: ['unit-tests', 'integration-tests', 'validator-tests', 'e2e', 'ci-reports'] },
  { module: 'intelligence-memory-dev', tabs: ['memory-vault', 'knowledge-graph', 'embeddings', 'recall', 'inspector'] },
  { module: 'docs', tabs: ['screens', 'api-inventory', 'database-schemas', 'architecture', 'workforce'] },
];

/** All 87 Command Hub routes */
export const ALL_HUB_ROUTES = ALL_HUB_MODULES.flatMap(m =>
  m.tabs.map(tab => `/command-hub/${m.module}/${tab}/`)
);

export const HUB_ROUTES_BY_ROLE: Record<string, string[]> = {
  developer: ALL_HUB_ROUTES,
  admin: [
    '/command-hub/admin/users/',
    '/command-hub/admin/permissions/',
    '/command-hub/admin/tenants/',
    '/command-hub/admin/content-moderation/',
    '/command-hub/admin/identity-access/',
    '/command-hub/admin/analytics/',
    '/command-hub/command-hub/tasks/',
    '/command-hub/command-hub/approvals/',
    '/command-hub/overview/system-overview/',
  ],
  staff: [
    '/command-hub/command-hub/tasks/',
    '/command-hub/operator/dashboard/',
    '/command-hub/operator/task-queue/',
    '/command-hub/overview/system-overview/',
  ],
};

// ─── Backward-compatible exports (existing specs import these) ──────────────

/**
 * Community frontend routes per role.
 * Expanded from App.tsx — covers all 272 static routes.
 */
export const COMMUNITY_ROUTES_BY_ROLE: Record<string, string[]> = {
  community: COMMUNITY_BASE_ROUTES,
  patient: [...COMMUNITY_BASE_ROUTES, ...PATIENT_ROUTES],
  professional: [...COMMUNITY_BASE_ROUTES, ...PROFESSIONAL_ROUTES],
  staff: [...COMMUNITY_BASE_ROUTES, ...STAFF_ROUTES],
  admin: [...COMMUNITY_BASE_ROUTES, ...ADMIN_ROUTES],
};

export function getRoutesForRole(ui: 'desktop' | 'mobile' | 'hub', role: UserRole): string[] {
  if (ui === 'hub') return HUB_ROUTES_BY_ROLE[role] || [];
  return COMMUNITY_ROUTES_BY_ROLE[role] || [];
}
