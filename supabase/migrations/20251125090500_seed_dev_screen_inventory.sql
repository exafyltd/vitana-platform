-- Seed Developer Screen Inventory (87 screens) into OASIS specs
-- This spec defines the complete developer UI navigation structure

insert into public.oasis_specs (key, env, version, data)
values (
  'dev_screen_inventory_v1',
  'developer',
  1,
  '{
  "version": 1,
  "environment": "developer",
  "sidebar_navigation": [
    "overview",
    "admin",
    "operator",
    "command-hub",
    "governance",
    "agents",
    "workflows",
    "oasis",
    "databases",
    "infrastructure",
    "security-dev",
    "integrations-tools",
    "diagnostics",
    "models-evaluations",
    "testing-qa",
    "intelligence-memory-dev",
    "docs"
  ],
  "module_catalog": {
    "overview": [
      "system-overview",
      "live-metrics",
      "recent-events",
      "errors-violations",
      "release-feed"
    ],
    "admin": [
      "users",
      "permissions",
      "tenants",
      "content-moderation",
      "identity-access",
      "analytics"
    ],
    "operator": [
      "task-queue",
      "task-details",
      "execution-logs",
      "pipelines",
      "runbook"
    ],
    "command-hub": [
      "tasks",
      "live-console",
      "events",
      "vtids",
      "approvals"
    ],
    "governance": [
      "rules",
      "categories",
      "evaluations",
      "violations",
      "history",
      "proposals"
    ],
    "agents": [
      "registered-agents",
      "skills",
      "pipelines",
      "memory",
      "telemetry"
    ],
    "workflows": [
      "workflow-list",
      "triggers",
      "actions",
      "schedules",
      "history"
    ],
    "oasis": [
      "events",
      "vtid-ledger",
      "entities",
      "streams",
      "command-log"
    ],
    "databases": [
      "supabase",
      "vectors",
      "cache",
      "analytics",
      "clusters"
    ],
    "infrastructure": [
      "services",
      "health",
      "deployments",
      "logs",
      "config"
    ],
    "security-dev": [
      "policies",
      "roles",
      "keys-secrets",
      "audit-log",
      "rls-access"
    ],
    "integrations-tools": [
      "mcp-connectors",
      "llm-providers",
      "apis",
      "tools",
      "service-mesh"
    ],
    "diagnostics": [
      "health-checks",
      "latency",
      "errors",
      "sse",
      "debug-panel"
    ],
    "models-evaluations": [
      "models",
      "evaluations",
      "benchmarks",
      "routing",
      "playground"
    ],
    "testing-qa": [
      "unit-tests",
      "integration-tests",
      "validator-tests",
      "e2e",
      "ci-reports"
    ],
    "intelligence-memory-dev": [
      "memory-vault",
      "knowledge-graph",
      "embeddings",
      "recall",
      "inspector"
    ],
    "docs": [
      "screens",
      "api-inventory",
      "database-schemas",
      "architecture",
      "workforce"
    ]
  },
  "screen_inventory": {
    "total_screens": 87,
    "url_pattern": "$GATEWAY_URL/<module>/<tab>/",
    "role_default": "developer",
    "screens": [
      {"screen_id": "DEV_OVERVIEW_SYSTEM_OVERVIEW", "module": "overview", "tab": "system-overview", "url_path": "/overview/system-overview/", "role": "developer"},
      {"screen_id": "DEV_OVERVIEW_LIVE_METRICS", "module": "overview", "tab": "live-metrics", "url_path": "/overview/live-metrics/", "role": "developer"},
      {"screen_id": "DEV_OVERVIEW_RECENT_EVENTS", "module": "overview", "tab": "recent-events", "url_path": "/overview/recent-events/", "role": "developer"},
      {"screen_id": "DEV_OVERVIEW_ERRORS_VIOLATIONS", "module": "overview", "tab": "errors-violations", "url_path": "/overview/errors-violations/", "role": "developer"},
      {"screen_id": "DEV_OVERVIEW_RELEASE_FEED", "module": "overview", "tab": "release-feed", "url_path": "/overview/release-feed/", "role": "developer"},
      {"screen_id": "DEV_ADMIN_USERS", "module": "admin", "tab": "users", "url_path": "/admin/users/", "role": "developer"},
      {"screen_id": "DEV_ADMIN_PERMISSIONS", "module": "admin", "tab": "permissions", "url_path": "/admin/permissions/", "role": "developer"},
      {"screen_id": "DEV_ADMIN_TENANTS", "module": "admin", "tab": "tenants", "url_path": "/admin/tenants/", "role": "developer"},
      {"screen_id": "DEV_ADMIN_CONTENT_MODERATION", "module": "admin", "tab": "content-moderation", "url_path": "/admin/content-moderation/", "role": "developer"},
      {"screen_id": "DEV_ADMIN_IDENTITY_ACCESS", "module": "admin", "tab": "identity-access", "url_path": "/admin/identity-access/", "role": "developer"},
      {"screen_id": "DEV_ADMIN_ANALYTICS", "module": "admin", "tab": "analytics", "url_path": "/admin/analytics/", "role": "developer"},
      {"screen_id": "DEV_OPERATOR_TASK_QUEUE", "module": "operator", "tab": "task-queue", "url_path": "/operator/task-queue/", "role": "developer"},
      {"screen_id": "DEV_OPERATOR_TASK_DETAILS", "module": "operator", "tab": "task-details", "url_path": "/operator/task-details/", "role": "developer"},
      {"screen_id": "DEV_OPERATOR_EXECUTION_LOGS", "module": "operator", "tab": "execution-logs", "url_path": "/operator/execution-logs/", "role": "developer"},
      {"screen_id": "DEV_OPERATOR_PIPELINES", "module": "operator", "tab": "pipelines", "url_path": "/operator/pipelines/", "role": "developer"},
      {"screen_id": "DEV_OPERATOR_RUNBOOK", "module": "operator", "tab": "runbook", "url_path": "/operator/runbook/", "role": "developer"},
      {"screen_id": "DEV_COMMAND_HUB_TASKS", "module": "command-hub", "tab": "tasks", "url_path": "/command-hub/tasks/", "role": "developer"},
      {"screen_id": "DEV_COMMAND_HUB_LIVE_CONSOLE", "module": "command-hub", "tab": "live-console", "url_path": "/command-hub/live-console/", "role": "developer"},
      {"screen_id": "DEV_COMMAND_HUB_EVENTS", "module": "command-hub", "tab": "events", "url_path": "/command-hub/events/", "role": "developer"},
      {"screen_id": "DEV_COMMAND_HUB_VTIDS", "module": "command-hub", "tab": "vtids", "url_path": "/command-hub/vtids/", "role": "developer"},
      {"screen_id": "DEV_COMMAND_HUB_APPROVALS", "module": "command-hub", "tab": "approvals", "url_path": "/command-hub/approvals/", "role": "developer"},
      {"screen_id": "DEV_GOVERNANCE_RULES", "module": "governance", "tab": "rules", "url_path": "/governance/rules/", "role": "developer"},
      {"screen_id": "DEV_GOVERNANCE_CATEGORIES", "module": "governance", "tab": "categories", "url_path": "/governance/categories/", "role": "developer"},
      {"screen_id": "DEV_GOVERNANCE_EVALUATIONS", "module": "governance", "tab": "evaluations", "url_path": "/governance/evaluations/", "role": "developer"},
      {"screen_id": "DEV_GOVERNANCE_VIOLATIONS", "module": "governance", "tab": "violations", "url_path": "/governance/violations/", "role": "developer"},
      {"screen_id": "DEV_GOVERNANCE_HISTORY", "module": "governance", "tab": "history", "url_path": "/governance/history/", "role": "developer"},
      {"screen_id": "DEV_GOVERNANCE_PROPOSALS", "module": "governance", "tab": "proposals", "url_path": "/governance/proposals/", "role": "developer"},
      {"screen_id": "DEV_AGENTS_REGISTERED_AGENTS", "module": "agents", "tab": "registered-agents", "url_path": "/agents/registered-agents/", "role": "developer"},
      {"screen_id": "DEV_AGENTS_SKILLS", "module": "agents", "tab": "skills", "url_path": "/agents/skills/", "role": "developer"},
      {"screen_id": "DEV_AGENTS_PIPELINES", "module": "agents", "tab": "pipelines", "url_path": "/agents/pipelines/", "role": "developer"},
      {"screen_id": "DEV_AGENTS_MEMORY", "module": "agents", "tab": "memory", "url_path": "/agents/memory/", "role": "developer"},
      {"screen_id": "DEV_AGENTS_TELEMETRY", "module": "agents", "tab": "telemetry", "url_path": "/agents/telemetry/", "role": "developer"},
      {"screen_id": "DEV_WORKFLOWS_WORKFLOW_LIST", "module": "workflows", "tab": "workflow-list", "url_path": "/workflows/workflow-list/", "role": "developer"},
      {"screen_id": "DEV_WORKFLOWS_TRIGGERS", "module": "workflows", "tab": "triggers", "url_path": "/workflows/triggers/", "role": "developer"},
      {"screen_id": "DEV_WORKFLOWS_ACTIONS", "module": "workflows", "tab": "actions", "url_path": "/workflows/actions/", "role": "developer"},
      {"screen_id": "DEV_WORKFLOWS_SCHEDULES", "module": "workflows", "tab": "schedules", "url_path": "/workflows/schedules/", "role": "developer"},
      {"screen_id": "DEV_WORKFLOWS_HISTORY", "module": "workflows", "tab": "history", "url_path": "/workflows/history/", "role": "developer"},
      {"screen_id": "DEV_OASIS_EVENTS", "module": "oasis", "tab": "events", "url_path": "/oasis/events/", "role": "developer"},
      {"screen_id": "DEV_OASIS_VTID_LEDGER", "module": "oasis", "tab": "vtid-ledger", "url_path": "/oasis/vtid-ledger/", "role": "developer"},
      {"screen_id": "DEV_OASIS_ENTITIES", "module": "oasis", "tab": "entities", "url_path": "/oasis/entities/", "role": "developer"},
      {"screen_id": "DEV_OASIS_STREAMS", "module": "oasis", "tab": "streams", "url_path": "/oasis/streams/", "role": "developer"},
      {"screen_id": "DEV_OASIS_COMMAND_LOG", "module": "oasis", "tab": "command-log", "url_path": "/oasis/command-log/", "role": "developer"},
      {"screen_id": "DEV_DATABASES_SUPABASE", "module": "databases", "tab": "supabase", "url_path": "/databases/supabase/", "role": "developer"},
      {"screen_id": "DEV_DATABASES_VECTORS", "module": "databases", "tab": "vectors", "url_path": "/databases/vectors/", "role": "developer"},
      {"screen_id": "DEV_DATABASES_CACHE", "module": "databases", "tab": "cache", "url_path": "/databases/cache/", "role": "developer"},
      {"screen_id": "DEV_DATABASES_ANALYTICS", "module": "databases", "tab": "analytics", "url_path": "/databases/analytics/", "role": "developer"},
      {"screen_id": "DEV_DATABASES_CLUSTERS", "module": "databases", "tab": "clusters", "url_path": "/databases/clusters/", "role": "developer"},
      {"screen_id": "DEV_INFRASTRUCTURE_SERVICES", "module": "infrastructure", "tab": "services", "url_path": "/infrastructure/services/", "role": "developer"},
      {"screen_id": "DEV_INFRASTRUCTURE_HEALTH", "module": "infrastructure", "tab": "health", "url_path": "/infrastructure/health/", "role": "developer"},
      {"screen_id": "DEV_INFRASTRUCTURE_DEPLOYMENTS", "module": "infrastructure", "tab": "deployments", "url_path": "/infrastructure/deployments/", "role": "developer"},
      {"screen_id": "DEV_INFRASTRUCTURE_LOGS", "module": "infrastructure", "tab": "logs", "url_path": "/infrastructure/logs/", "role": "developer"},
      {"screen_id": "DEV_INFRASTRUCTURE_CONFIG", "module": "infrastructure", "tab": "config", "url_path": "/infrastructure/config/", "role": "developer"},
      {"screen_id": "DEV_SECURITY_DEV_POLICIES", "module": "security-dev", "tab": "policies", "url_path": "/security-dev/policies/", "role": "developer"},
      {"screen_id": "DEV_SECURITY_DEV_ROLES", "module": "security-dev", "tab": "roles", "url_path": "/security-dev/roles/", "role": "developer"},
      {"screen_id": "DEV_SECURITY_DEV_KEYS_SECRETS", "module": "security-dev", "tab": "keys-secrets", "url_path": "/security-dev/keys-secrets/", "role": "developer"},
      {"screen_id": "DEV_SECURITY_DEV_AUDIT_LOG", "module": "security-dev", "tab": "audit-log", "url_path": "/security-dev/audit-log/", "role": "developer"},
      {"screen_id": "DEV_SECURITY_DEV_RLS_ACCESS", "module": "security-dev", "tab": "rls-access", "url_path": "/security-dev/rls-access/", "role": "developer"},
      {"screen_id": "DEV_INTEGRATIONS_TOOLS_MCP_CONNECTORS", "module": "integrations-tools", "tab": "mcp-connectors", "url_path": "/integrations-tools/mcp-connectors/", "role": "developer"},
      {"screen_id": "DEV_INTEGRATIONS_TOOLS_LLM_PROVIDERS", "module": "integrations-tools", "tab": "llm-providers", "url_path": "/integrations-tools/llm-providers/", "role": "developer"},
      {"screen_id": "DEV_INTEGRATIONS_TOOLS_APIS", "module": "integrations-tools", "tab": "apis", "url_path": "/integrations-tools/apis/", "role": "developer"},
      {"screen_id": "DEV_INTEGRATIONS_TOOLS_TOOLS", "module": "integrations-tools", "tab": "tools", "url_path": "/integrations-tools/tools/", "role": "developer"},
      {"screen_id": "DEV_INTEGRATIONS_TOOLS_SERVICE_MESH", "module": "integrations-tools", "tab": "service-mesh", "url_path": "/integrations-tools/service-mesh/", "role": "developer"},
      {"screen_id": "DEV_DIAGNOSTICS_HEALTH_CHECKS", "module": "diagnostics", "tab": "health-checks", "url_path": "/diagnostics/health-checks/", "role": "developer"},
      {"screen_id": "DEV_DIAGNOSTICS_LATENCY", "module": "diagnostics", "tab": "latency", "url_path": "/diagnostics/latency/", "role": "developer"},
      {"screen_id": "DEV_DIAGNOSTICS_ERRORS", "module": "diagnostics", "tab": "errors", "url_path": "/diagnostics/errors/", "role": "developer"},
      {"screen_id": "DEV_DIAGNOSTICS_SSE", "module": "diagnostics", "tab": "sse", "url_path": "/diagnostics/sse/", "role": "developer"},
      {"screen_id": "DEV_DIAGNOSTICS_DEBUG_PANEL", "module": "diagnostics", "tab": "debug-panel", "url_path": "/diagnostics/debug-panel/", "role": "developer"},
      {"screen_id": "DEV_MODELS_EVALUATIONS_MODELS", "module": "models-evaluations", "tab": "models", "url_path": "/models-evaluations/models/", "role": "developer"},
      {"screen_id": "DEV_MODELS_EVALUATIONS_EVALUATIONS", "module": "models-evaluations", "tab": "evaluations", "url_path": "/models-evaluations/evaluations/", "role": "developer"},
      {"screen_id": "DEV_MODELS_EVALUATIONS_BENCHMARKS", "module": "models-evaluations", "tab": "benchmarks", "url_path": "/models-evaluations/benchmarks/", "role": "developer"},
      {"screen_id": "DEV_MODELS_EVALUATIONS_ROUTING", "module": "models-evaluations", "tab": "routing", "url_path": "/models-evaluations/routing/", "role": "developer"},
      {"screen_id": "DEV_MODELS_EVALUATIONS_PLAYGROUND", "module": "models-evaluations", "tab": "playground", "url_path": "/models-evaluations/playground/", "role": "developer"},
      {"screen_id": "DEV_TESTING_QA_UNIT_TESTS", "module": "testing-qa", "tab": "unit-tests", "url_path": "/testing-qa/unit-tests/", "role": "developer"},
      {"screen_id": "DEV_TESTING_QA_INTEGRATION_TESTS", "module": "testing-qa", "tab": "integration-tests", "url_path": "/testing-qa/integration-tests/", "role": "developer"},
      {"screen_id": "DEV_TESTING_QA_VALIDATOR_TESTS", "module": "testing-qa", "tab": "validator-tests", "url_path": "/testing-qa/validator-tests/", "role": "developer"},
      {"screen_id": "DEV_TESTING_QA_E2E", "module": "testing-qa", "tab": "e2e", "url_path": "/testing-qa/e2e/", "role": "developer"},
      {"screen_id": "DEV_TESTING_QA_CI_REPORTS", "module": "testing-qa", "tab": "ci-reports", "url_path": "/testing-qa/ci-reports/", "role": "developer"},
      {"screen_id": "DEV_INTELLIGENCE_MEMORY_DEV_MEMORY_VAULT", "module": "intelligence-memory-dev", "tab": "memory-vault", "url_path": "/intelligence-memory-dev/memory-vault/", "role": "developer"},
      {"screen_id": "DEV_INTELLIGENCE_MEMORY_DEV_KNOWLEDGE_GRAPH", "module": "intelligence-memory-dev", "tab": "knowledge-graph", "url_path": "/intelligence-memory-dev/knowledge-graph/", "role": "developer"},
      {"screen_id": "DEV_INTELLIGENCE_MEMORY_DEV_EMBEDDINGS", "module": "intelligence-memory-dev", "tab": "embeddings", "url_path": "/intelligence-memory-dev/embeddings/", "role": "developer"},
      {"screen_id": "DEV_INTELLIGENCE_MEMORY_DEV_RECALL", "module": "intelligence-memory-dev", "tab": "recall", "url_path": "/intelligence-memory-dev/recall/", "role": "developer"},
      {"screen_id": "DEV_INTELLIGENCE_MEMORY_DEV_INSPECTOR", "module": "intelligence-memory-dev", "tab": "inspector", "url_path": "/intelligence-memory-dev/inspector/", "role": "developer"},
      {"screen_id": "DEV_DOCS_SCREENS", "module": "docs", "tab": "screens", "url_path": "/docs/screens/", "role": "developer"},
      {"screen_id": "DEV_DOCS_API_INVENTORY", "module": "docs", "tab": "api-inventory", "url_path": "/docs/api-inventory/", "role": "developer"},
      {"screen_id": "DEV_DOCS_DATABASE_SCHEMAS", "module": "docs", "tab": "database-schemas", "url_path": "/docs/database-schemas/", "role": "developer"},
      {"screen_id": "DEV_DOCS_ARCHITECTURE", "module": "docs", "tab": "architecture", "url_path": "/docs/architecture/", "role": "developer"},
      {"screen_id": "DEV_DOCS_WORKFORCE", "module": "docs", "tab": "workforce", "url_path": "/docs/workforce/", "role": "developer"}
    ]
  }
}'::jsonb
)
on conflict (key) do update
set env = excluded.env,
    version = excluded.version,
    data = excluded.data,
    updated_at = now();
