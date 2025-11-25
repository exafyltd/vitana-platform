/**
 * Vitana Developer Catalog – Canonical Navigation Config
 * VTID: DEV-CICDL-0205
 *
 * This file is the SINGLE SOURCE for frontend navigation structure.
 * It must match the OASIS spec: 17 modules, 87 screens, exact order.
 *
 * DO NOT modify without updating the spec in OASIS first.
 * CI will fail if this deviates from specs/dev_screen_inventory_v1.json.
 */

export const NAVIGATION_CONFIG = [
  {
    module: 'overview',
    label: 'Overview',
    tabs: [
      { key: 'system-overview', label: 'System Overview' },
      { key: 'live-metrics', label: 'Live Metrics' },
      { key: 'recent-events', label: 'Recent Events' },
      { key: 'errors-violations', label: 'Errors & Violations' },
      { key: 'release-feed', label: 'Release Feed' }
    ]
  },
  {
    module: 'admin',
    label: 'Admin',
    tabs: [
      { key: 'users', label: 'Users' },
      { key: 'permissions', label: 'Permissions' },
      { key: 'tenants', label: 'Tenants' },
      { key: 'content-moderation', label: 'Content Moderation' },
      { key: 'identity-access', label: 'Identity & Access' },
      { key: 'analytics', label: 'Analytics' }
    ]
  },
  {
    module: 'operator',
    label: 'Operator',
    tabs: [
      { key: 'task-queue', label: 'Task Queue' },
      { key: 'task-details', label: 'Task Details' },
      { key: 'execution-logs', label: 'Execution Logs' },
      { key: 'pipelines', label: 'Pipelines' },
      { key: 'runbook', label: 'Runbook' }
    ]
  },
  {
    module: 'command-hub',
    label: 'Command Hub',
    tabs: [
      { key: 'tasks', label: 'Tasks' },
      { key: 'live-console', label: 'Live Console' },
      { key: 'events', label: 'Events' },
      { key: 'vtids', label: 'VTIDs' },
      { key: 'approvals', label: 'Approvals' }
    ]
  },
  {
    module: 'governance',
    label: 'Governance',
    tabs: [
      { key: 'rules', label: 'Rules' },
      { key: 'categories', label: 'Categories' },
      { key: 'evaluations', label: 'Evaluations' },
      { key: 'violations', label: 'Violations' },
      { key: 'history', label: 'History' },
      { key: 'proposals', label: 'Proposals' }
    ]
  },
  {
    module: 'agents',
    label: 'Agents',
    tabs: [
      { key: 'registered-agents', label: 'Registered Agents' },
      { key: 'skills', label: 'Skills' },
      { key: 'pipelines', label: 'Pipelines' },
      { key: 'memory', label: 'Memory' },
      { key: 'telemetry', label: 'Telemetry' }
    ]
  },
  {
    module: 'workflows',
    label: 'Workflows',
    tabs: [
      { key: 'workflow-list', label: 'Workflow List' },
      { key: 'triggers', label: 'Triggers' },
      { key: 'actions', label: 'Actions' },
      { key: 'schedules', label: 'Schedules' },
      { key: 'history', label: 'History' }
    ]
  },
  {
    module: 'oasis',
    label: 'OASIS',
    tabs: [
      { key: 'events', label: 'Events' },
      { key: 'vtid-ledger', label: 'VTID Ledger' },
      { key: 'entities', label: 'Entities' },
      { key: 'streams', label: 'Streams' },
      { key: 'command-log', label: 'Command Log' }
    ]
  },
  {
    module: 'databases',
    label: 'Databases',
    tabs: [
      { key: 'supabase', label: 'Supabase' },
      { key: 'vectors', label: 'Vectors' },
      { key: 'cache', label: 'Cache' },
      { key: 'analytics', label: 'Analytics' },
      { key: 'clusters', label: 'Clusters' }
    ]
  },
  {
    module: 'infrastructure',
    label: 'Infrastructure',
    tabs: [
      { key: 'services', label: 'Services' },
      { key: 'health', label: 'Health' },
      { key: 'deployments', label: 'Deployments' },
      { key: 'logs', label: 'Logs' },
      { key: 'config', label: 'Config' }
    ]
  },
  {
    module: 'security-dev',
    label: 'Security',
    tabs: [
      { key: 'policies', label: 'Policies' },
      { key: 'roles', label: 'Roles' },
      { key: 'keys-secrets', label: 'Keys & Secrets' },
      { key: 'audit-log', label: 'Audit Log' },
      { key: 'rls-access', label: 'RLS & Access' }
    ]
  },
  {
    module: 'integrations-tools',
    label: 'Integrations & Tools',
    tabs: [
      { key: 'mcp-connectors', label: 'MCP Connectors' },
      { key: 'llm-providers', label: 'LLM Providers' },
      { key: 'apis', label: 'APIs' },
      { key: 'tools', label: 'Tools' },
      { key: 'service-mesh', label: 'Service Mesh' }
    ]
  },
  {
    module: 'diagnostics',
    label: 'Diagnostics',
    tabs: [
      { key: 'health-checks', label: 'Health Checks' },
      { key: 'latency', label: 'Latency' },
      { key: 'errors', label: 'Errors' },
      { key: 'sse', label: 'SSE' },
      { key: 'debug-panel', label: 'Debug Panel' }
    ]
  },
  {
    module: 'models-evaluations',
    label: 'Models & Evaluations',
    tabs: [
      { key: 'models', label: 'Models' },
      { key: 'evaluations', label: 'Evaluations' },
      { key: 'benchmarks', label: 'Benchmarks' },
      { key: 'routing', label: 'Routing' },
      { key: 'playground', label: 'Playground' }
    ]
  },
  {
    module: 'testing-qa',
    label: 'Testing & QA',
    tabs: [
      { key: 'unit-tests', label: 'Unit Tests' },
      { key: 'integration-tests', label: 'Integration Tests' },
      { key: 'validator-tests', label: 'Validator Tests' },
      { key: 'e2e', label: 'E2E' },
      { key: 'ci-reports', label: 'CI Reports' }
    ]
  },
  {
    module: 'intelligence-memory-dev',
    label: 'Intelligence & Memory',
    tabs: [
      { key: 'memory-vault', label: 'Memory Vault' },
      { key: 'knowledge-graph', label: 'Knowledge Graph' },
      { key: 'embeddings', label: 'Embeddings' },
      { key: 'recall', label: 'Recall' },
      { key: 'inspector', label: 'Inspector' }
    ]
  },
  {
    module: 'docs',
    label: 'Docs',
    tabs: [
      { key: 'screens', label: 'Screens' },
      { key: 'api-inventory', label: 'API Inventory' },
      { key: 'database-schemas', label: 'Database Schemas' },
      { key: 'architecture', label: 'Architecture' },
      { key: 'workforce', label: 'Workforce' }
    ]
  }
];
