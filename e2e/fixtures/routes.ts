import type { UserRole } from './test-users';

/**
 * Known community frontend routes per role.
 * These will be expanded as we discover more routes via Playwright CLI exploration.
 */
export const COMMUNITY_ROUTES_BY_ROLE: Record<string, string[]> = {
  community: [
    '/',
    '/discover',
    '/community',
    '/community/groups',
    '/community/meetups',
    '/messages',
    '/inbox',
    '/live',
    '/autopilot',
    '/settings',
    '/profile',
  ],
  patient: [
    '/',
    '/health',
    '/diary',
    '/signals',
    '/discover',
    '/community',
    '/messages',
    '/settings',
    '/profile',
  ],
  professional: [
    '/',
    '/dashboard',
    '/patients',
    '/community',
    '/messages',
    '/settings',
    '/profile',
  ],
  staff: [
    '/',
    '/moderation',
    '/community',
    '/messages',
    '/settings',
    '/profile',
  ],
  admin: [
    '/',
    '/admin/users',
    '/admin/tenants',
    '/admin/analytics',
    '/community',
    '/messages',
    '/settings',
    '/profile',
  ],
};

/**
 * Command Hub routes per role.
 * Generated from navigation-config.js (17 modules, 87 screens).
 */
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
  { module: 'infrastructure', tabs: ['services', 'health', 'deployments', 'logs', 'config'] },
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

export function getRoutesForRole(ui: 'desktop' | 'mobile' | 'hub', role: UserRole): string[] {
  if (ui === 'hub') return HUB_ROUTES_BY_ROLE[role] || [];
  return COMMUNITY_ROUTES_BY_ROLE[role] || [];
}
