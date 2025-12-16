// Vitana Dev Frontend Spec v2 Implementation - Task 3

// VTID-0539: Operator Console Chat Experience Improvements
console.log('🔥 COMMAND HUB BUNDLE: VTID-0539 LIVE 🔥');

// --- Configs ---

const NAVIGATION_CONFIG = [
    {
        "section": "overview",
        "basePath": "/command-hub/overview/",
        "tabs": [
            { "key": "system-overview", "path": "/command-hub/overview/system-overview/" },
            { "key": "live-metrics", "path": "/command-hub/overview/live-metrics/" },
            { "key": "recent-events", "path": "/command-hub/overview/recent-events/" },
            { "key": "errors-violations", "path": "/command-hub/overview/errors-violations/" },
            { "key": "release-feed", "path": "/command-hub/overview/release-feed/" }
        ]
    },
    {
        "section": "admin",
        "basePath": "/command-hub/admin/",
        "tabs": [
            { "key": "users", "path": "/command-hub/admin/users/" },
            { "key": "permissions", "path": "/command-hub/admin/permissions/" },
            { "key": "tenants", "path": "/command-hub/admin/tenants/" },
            { "key": "content-moderation", "path": "/command-hub/admin/content-moderation/" },
            { "key": "identity-access", "path": "/command-hub/admin/identity-access/" },
            { "key": "analytics", "path": "/command-hub/admin/analytics/" }
        ]
    },
    {
        "section": "operator",
        "basePath": "/command-hub/operator/",
        "tabs": [
            { "key": "task-queue", "path": "/command-hub/operator/task-queue/" },
            { "key": "task-details", "path": "/command-hub/operator/task-details/" },
            { "key": "execution-logs", "path": "/command-hub/operator/execution-logs/" },
            { "key": "pipelines", "path": "/command-hub/operator/pipelines/" },
            { "key": "runbook", "path": "/command-hub/operator/runbook/" }
        ]
    },
    {
        "section": "command-hub",
        "basePath": "/command-hub/",
        "tabs": [
            { "key": "tasks", "path": "/command-hub/tasks/" },
            { "key": "live-console", "path": "/command-hub/live-console/" },
            { "key": "events", "path": "/command-hub/events/" },
            { "key": "vtids", "path": "/command-hub/vtids/" },
            { "key": "approvals", "path": "/command-hub/approvals/" }
        ]
    },
    {
        "section": "governance",
        "basePath": "/command-hub/governance/",
        "tabs": [
            { "key": "rules", "path": "/command-hub/governance/rules/" },
            { "key": "categories", "path": "/command-hub/governance/categories/" },
            { "key": "evaluations", "path": "/command-hub/governance/evaluations/" },
            { "key": "violations", "path": "/command-hub/governance/violations/" },
            { "key": "history", "path": "/command-hub/governance/history/" },
            { "key": "proposals", "path": "/command-hub/governance/proposals/" }
        ]
    },
    {
        "section": "agents",
        "basePath": "/command-hub/agents/",
        "tabs": [
            { "key": "registered-agents", "path": "/command-hub/agents/registered-agents/" },
            { "key": "skills", "path": "/command-hub/agents/skills/" },
            { "key": "pipelines", "path": "/command-hub/agents/pipelines/" },
            { "key": "memory", "path": "/command-hub/agents/memory/" },
            { "key": "telemetry", "path": "/command-hub/agents/telemetry/" }
        ]
    },
    {
        "section": "workflows",
        "basePath": "/command-hub/workflows/",
        "tabs": [
            { "key": "workflow-list", "path": "/command-hub/workflows/workflow-list/" },
            { "key": "triggers", "path": "/command-hub/workflows/triggers/" },
            { "key": "actions", "path": "/command-hub/workflows/actions/" },
            { "key": "schedules", "path": "/command-hub/workflows/schedules/" },
            { "key": "history", "path": "/command-hub/workflows/history/" }
        ]
    },
    {
        "section": "oasis",
        "basePath": "/command-hub/oasis/",
        "tabs": [
            { "key": "events", "path": "/command-hub/oasis/events/" },
            { "key": "vtid-ledger", "path": "/command-hub/oasis/vtid-ledger/" },
            { "key": "entities", "path": "/command-hub/oasis/entities/" },
            { "key": "streams", "path": "/command-hub/oasis/streams/" },
            { "key": "command-log", "path": "/command-hub/oasis/command-log/" }
        ]
    },
    {
        "section": "databases",
        "basePath": "/command-hub/databases/",
        "tabs": [
            { "key": "supabase", "path": "/command-hub/databases/supabase/" },
            { "key": "vectors", "path": "/command-hub/databases/vectors/" },
            { "key": "cache", "path": "/command-hub/databases/cache/" },
            { "key": "analytics", "path": "/command-hub/databases/analytics/" },
            { "key": "clusters", "path": "/command-hub/databases/clusters/" }
        ]
    },
    {
        "section": "infrastructure",
        "basePath": "/command-hub/infrastructure/",
        "tabs": [
            { "key": "services", "path": "/command-hub/infrastructure/services/" },
            { "key": "health", "path": "/command-hub/infrastructure/health/" },
            { "key": "deployments", "path": "/command-hub/infrastructure/deployments/" },
            { "key": "logs", "path": "/command-hub/infrastructure/logs/" },
            { "key": "config", "path": "/command-hub/infrastructure/config/" }
        ]
    },
    {
        "section": "security-dev",
        "basePath": "/command-hub/security-dev/",
        "tabs": [
            { "key": "policies", "path": "/command-hub/security-dev/policies/" },
            { "key": "roles", "path": "/command-hub/security-dev/roles/" },
            { "key": "keys-secrets", "path": "/command-hub/security-dev/keys-secrets/" },
            { "key": "audit-log", "path": "/command-hub/security-dev/audit-log/" },
            { "key": "rls-access", "path": "/command-hub/security-dev/rls-access/" }
        ]
    },
    {
        "section": "integrations-tools",
        "basePath": "/command-hub/integrations-tools/",
        "tabs": [
            { "key": "mcp-connectors", "path": "/command-hub/integrations-tools/mcp-connectors/" },
            { "key": "llm-providers", "path": "/command-hub/integrations-tools/llm-providers/" },
            { "key": "apis", "path": "/command-hub/integrations-tools/apis/" },
            { "key": "tools", "path": "/command-hub/integrations-tools/tools/" },
            { "key": "service-mesh", "path": "/command-hub/integrations-tools/service-mesh/" }
        ]
    },
    {
        "section": "diagnostics",
        "basePath": "/command-hub/diagnostics/",
        "tabs": [
            { "key": "health-checks", "path": "/command-hub/diagnostics/health-checks/" },
            { "key": "latency", "path": "/command-hub/diagnostics/latency/" },
            { "key": "errors", "path": "/command-hub/diagnostics/errors/" },
            { "key": "sse", "path": "/command-hub/diagnostics/sse/" },
            { "key": "debug-panel", "path": "/command-hub/diagnostics/debug-panel/" }
        ]
    },
    {
        "section": "models-evaluations",
        "basePath": "/command-hub/models-evaluations/",
        "tabs": [
            { "key": "models", "path": "/command-hub/models-evaluations/models/" },
            { "key": "evaluations", "path": "/command-hub/models-evaluations/evaluations/" },
            { "key": "benchmarks", "path": "/command-hub/models-evaluations/benchmarks/" },
            { "key": "routing", "path": "/command-hub/models-evaluations/routing/" },
            { "key": "playground", "path": "/command-hub/models-evaluations/playground/" }
        ]
    },
    {
        "section": "testing-qa",
        "basePath": "/command-hub/testing-qa/",
        "tabs": [
            { "key": "unit-tests", "path": "/command-hub/testing-qa/unit-tests/" },
            { "key": "integration-tests", "path": "/command-hub/testing-qa/integration-tests/" },
            { "key": "validator-tests", "path": "/command-hub/testing-qa/validator-tests/" },
            { "key": "e2e", "path": "/command-hub/testing-qa/e2e/" },
            { "key": "ci-reports", "path": "/command-hub/testing-qa/ci-reports/" }
        ]
    },
    {
        "section": "intelligence-memory-dev",
        "basePath": "/command-hub/intelligence-memory-dev/",
        "tabs": [
            { "key": "memory-vault", "path": "/command-hub/intelligence-memory-dev/memory-vault/" },
            { "key": "knowledge-graph", "path": "/command-hub/intelligence-memory-dev/knowledge-graph/" },
            { "key": "embeddings", "path": "/command-hub/intelligence-memory-dev/embeddings/" },
            { "key": "recall", "path": "/command-hub/intelligence-memory-dev/recall/" },
            { "key": "inspector", "path": "/command-hub/intelligence-memory-dev/inspector/" }
        ]
    },
    {
        "section": "docs",
        "basePath": "/command-hub/docs/",
        "tabs": [
            { "key": "screens", "path": "/command-hub/docs/screens/" },
            { "key": "api-inventory", "path": "/command-hub/docs/api-inventory/" },
            { "key": "database-schemas", "path": "/command-hub/docs/database-schemas/" },
            { "key": "architecture", "path": "/command-hub/docs/architecture/" },
            { "key": "workforce", "path": "/command-hub/docs/workforce/" }
        ]
    }
];

const SECTION_LABELS = {
    'overview': 'Overview',
    'admin': 'Admin',
    'operator': 'Operator',
    'command-hub': 'Command Hub',
    'governance': 'Governance',
    'agents': 'Agents',
    'workflows': 'Workflows',
    'oasis': 'OASIS',
    'databases': 'Databases',
    'infrastructure': 'Infrastructure',
    'security-dev': 'Security (Dev)',
    'integrations-tools': 'Integrations & Tools',
    'diagnostics': 'Diagnostics',
    'models-evaluations': 'Models & Evaluations',
    'testing-qa': 'Testing & QA',
    'intelligence-memory-dev': 'Intelligence & Memory (Dev)',
    'docs': 'Docs'
};

const splitScreenCombos = [
    { id: 'operatorLogs+commandHubTasks', label: 'Operator Logs + Tasks', left: { module: 'operator', tab: 'execution-logs' }, right: { module: 'command-hub', tab: 'tasks' } },
    { id: 'commandHubTasks+commandHubDetail', label: 'Tasks + Live Console', left: { module: 'command-hub', tab: 'tasks' }, right: { module: 'command-hub', tab: 'live-console' } },
    { id: 'oasisEvents+commandHubHistory', label: 'OASIS Events + History', left: { module: 'oasis', tab: 'events' }, right: { module: 'governance', tab: 'history' } },
    { id: 'governanceEvaluations+commandHubTasks', label: 'Gov Evals + Tasks', left: { module: 'governance', tab: 'evaluations' }, right: { module: 'command-hub', tab: 'tasks' } },
    { id: 'agentsActivity+operatorLogs', label: 'Agents + Operator', left: { module: 'agents', tab: 'pipelines' }, right: { module: 'operator', tab: 'execution-logs' } },
    { id: 'testingRuns+commandHubTasks', label: 'Test Runs + Tasks', left: { module: 'testing-qa', tab: 'e2e' }, right: { module: 'command-hub', tab: 'tasks' } }
];

// --- State ---

const state = {
    currentModuleKey: 'command-hub', // Will be overwritten by router
    currentTab: 'tasks', // Will be overwritten by router
    sidebarCollapsed: false,

    // Tasks
    tasks: [],
    tasksLoading: false,
    tasksError: null,
    selectedTask: null,
    // VTID-0527: VTID detail with stageTimeline from API
    selectedTaskDetail: null,
    selectedTaskDetailLoading: false,
    taskSearchQuery: '',
    taskDateFilter: '',

    // Split Screen
    isSplitScreen: false,
    activeSplitScreenId: null,
    leftPane: null,
    rightPane: null,

    // Modals
    showProfileModal: false,
    showTaskModal: false,

    // Global Overlays (VTID-0508 / VTID-0509)
    isHeartbeatOpen: false,
    isOperatorOpen: false,
    operatorActiveTab: 'ticker', // 'chat', 'ticker', 'history'

    // VTID-0509: Operator Console State
    operatorHeartbeatActive: false,
    operatorSseSource: null,
    operatorHeartbeatSnapshot: null,

    // Operator Chat State
    chatMessages: [],
    chatInputValue: '',
    chatAttachments: [], // Array of { oasis_ref, kind, name }
    chatSending: false,
    chatIsTyping: false, // VTID-0526-D: Guard against scroll/render during typing

    // Operator Ticker State
    tickerEvents: [],

    // VTID-0526-D: Stage Counters State (4-stage model)
    stageCounters: {
        PLANNER: 0,
        WORKER: 0,
        VALIDATOR: 0,
        DEPLOY: 0
    },
    stageCountersLoading: false,
    telemetrySnapshotError: null,
    lastTelemetryRefresh: null,
    telemetryAutoRefreshEnabled: true,

    // VTID-0527: Raw telemetry events for task stage computation
    telemetryEvents: [],

    // DEV-COMHU-0202: Global events state for VTID correlation
    events: [],

    // Operator History State
    historyEvents: [],
    historyLoading: false,
    historyError: null,

    // User
    user: {
        name: 'David Stevens',
        role: 'Admin',
        avatar: 'DS'
    },

    // Docs / Screen Inventory
    screenInventory: null,
    screenInventoryLoading: false,
    screenInventoryError: null,
    selectedRole: 'DEVELOPER',

    // Version History (VTID-0517)
    isVersionDropdownOpen: false,
    versionHistory: [],
    selectedVersionId: null,

    // Publish Modal (VTID-0517)
    showPublishModal: false,

    // VTID-0407: Governance Blocked Modal
    showGovernanceBlockedModal: false,
    governanceBlockedData: null, // { level, violations, service, vtid }

    // Toast Notifications (VTID-0517)
    toasts: [],

    // CI/CD Health (VTID-0520)
    cicdHealth: null,
    cicdHealthLoading: false,
    cicdHealthError: null,
    cicdHealthTooltipOpen: false,

    // Governance Rules (VTID-0401, VTID-0405)
    governanceRules: [],
    governanceRulesLoading: false,
    governanceRulesError: null,
    governanceRulesSearchQuery: '',
    governanceRulesLevelFilter: '',
    governanceRulesCategoryFilter: '',
    governanceRulesSourceFilter: '',
    governanceRulesSortColumn: 'id',
    governanceRulesSortDirection: 'asc',
    selectedGovernanceRule: null,

    // VTID-0406: Governance Evaluations (OASIS Integration)
    governanceEvaluations: [],
    governanceEvaluationsLoading: false,
    governanceEvaluationsError: null,
    governanceEvaluationsResultFilter: '',
    governanceEvaluationsFetched: false,

    // VTID-0408: Governance History (Event Timeline)
    governanceHistory: {
        items: [],
        loading: false,
        error: null,
        filters: {
            type: 'all',
            level: 'all',
            actor: 'all',
            range: '7d'
        },
        pagination: {
            limit: 50,
            offset: 0,
            hasMore: false
        },
        selectedEvent: null,
        fetched: false
    },

    // VTID-0409: Governance Categories (Read-Only V1)
    governanceCategories: {
        items: [],
        loading: false,
        error: null,
        selectedCategoryId: null,
        fetched: false
    },

    // VTID-0150-A: ORB UI State (Global Assistant Overlay)
    // VTID-0150-B: Added sessionId for Assistant Core integration
    orb: {
        overlayVisible: false,
        chatDrawerOpen: false,
        micActive: false,
        cameraActive: false,
        screenShareActive: false,
        isThinking: false,
        sessionId: null, // VTID-0150-B: Tracks Assistant Core session
        chatMessages: [
            // Initial assistant greeting
            { id: 1, role: 'assistant', content: 'Hello! I\'m your Vitana assistant. How can I help you today?', timestamp: new Date().toISOString() }
        ],
        chatInputValue: ''
    },

    // VTID-0600: Operational Visibility Foundation State
    oasisEvents: {
        items: [],
        loading: false,
        error: null,
        fetched: false,
        selectedEvent: null,
        filters: {
            topic: '',
            service: '',
            status: ''
        },
        autoRefreshEnabled: true,
        autoRefreshInterval: null
    },

    // VTID-0600: Command Hub Events (Curated Operational View)
    commandHubEvents: {
        items: [],
        loading: false,
        error: null,
        fetched: false,
        filters: {
            topic: '',
            service: '',
            status: ''
        }
    },

    // VTID-0600: VTIDs Lifecycle Overview
    vtidsList: {
        items: [],
        loading: false,
        error: null,
        fetched: false,
        selectedVtid: null
    },

    // DEV-COMHU-2025-0008: VTID Ledger from authoritative API
    vtidLedger: {
        items: [],
        loading: false,
        error: null,
        fetched: false
    },

    // VTID-0600: Approvals UI Scaffolding
    approvals: {
        items: [],
        loading: false,
        error: null,
        fetched: false
    },

    // VTID-0600: Ticker Severity Prioritization
    tickerCollapseHeartbeat: true,
    tickerSeverityFilter: 'all' // 'all', 'critical', 'important', 'info'
};

// --- VTID-0527: Task Stage Timeline Model ---

/**
 * VTID-0527: Task execution stages in order.
 * This defines the 4-stage pipeline: PLANNER → WORKER → VALIDATOR → DEPLOY
 */
const TASK_STAGES = ['PLANNER', 'WORKER', 'VALIDATOR', 'DEPLOY'];

/**
 * VTID-0527: Stage display labels (short form for pills)
 */
const STAGE_LABELS = {
    PLANNER: 'PL',
    WORKER: 'WO',
    VALIDATOR: 'VA',
    DEPLOY: 'DE'
};

/**
 * VTID-0527: Derive task stage state from telemetry events.
 * Computes which stages are completed, current, and pending for a task.
 *
 * @param {Object} task - Task object with vtid
 * @param {Array} events - Telemetry events array
 * @returns {Object} Stage state object
 */
function deriveTaskStageState(task, events) {
    // Filter events relevant to this task by vtid
    const relevantEvents = events.filter(function(ev) {
        return ev.vtid === task.vtid;
    });

    // Build stage info
    const byStage = {};
    TASK_STAGES.forEach(function(stage) {
        const stageEvents = relevantEvents.filter(function(ev) {
            return ev.task_stage === stage;
        });
        byStage[stage] = {
            reached: stageEvents.length > 0,
            latestEvent: stageEvents.length > 0 ? stageEvents.reduce(function(a, b) {
                return new Date(a.created_at) > new Date(b.created_at) ? a : b;
            }) : null,
            eventCount: stageEvents.length
        };
    });

    // Determine current stage (highest reached stage)
    let currentStage = null;
    for (var i = TASK_STAGES.length - 1; i >= 0; i--) {
        if (byStage[TASK_STAGES[i]].reached) {
            currentStage = TASK_STAGES[i];
            break;
        }
    }

    // Build completed/pending lists
    const completed = [];
    const pending = [];
    let reachedCurrent = false;

    TASK_STAGES.forEach(function(stage) {
        if (byStage[stage].reached) {
            if (stage === currentStage) {
                reachedCurrent = true;
            } else if (!reachedCurrent) {
                completed.push(stage);
            }
        } else {
            pending.push(stage);
        }
    });

    return {
        currentStage: currentStage,
        completed: completed,
        pending: pending,
        byStage: byStage,
        hasAnyStage: currentStage !== null
    };
}

/**
 * VTID-0527: Format timestamp for stage detail display
 */
function formatStageTimestamp(isoString) {
    if (!isoString) return 'N/A';
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// --- VTID-0600: Operational Visibility Foundation ---

/**
 * VTID-0600: Event Severity Levels
 * Used for prioritizing and color-coding events in ticker and views.
 */
const EVENT_SEVERITY = {
    CRITICAL: 'critical',   // deploy failed, governance denied
    IMPORTANT: 'important', // deploy success, governance allowed
    INFO: 'info',           // autopilot events, general operations
    LOW: 'low'              // heartbeat, pings, routine checks
};

/**
 * VTID-0600: Severity color mapping (CSP compliant hex values)
 */
const SEVERITY_COLORS = {
    critical: '#ff4d4f',
    important: '#f7b731',
    info: '#2ecc71',
    low: '#95a5a6'
};

/**
 * VTID-0600: Determine event severity based on topic and status
 * @param {Object} event - OASIS event object
 * @returns {string} Severity level (critical, important, info, low)
 */
function getEventSeverity(event) {
    const topic = (event.topic || '').toLowerCase();
    const status = (event.status || '').toLowerCase();

    // Critical: failures, denials, blocked events
    if (status === 'error' || status === 'fail' || status === 'blocked') {
        return EVENT_SEVERITY.CRITICAL;
    }
    if (topic.includes('.failed') || topic.includes('.blocked') || topic.includes('.denied')) {
        return EVENT_SEVERITY.CRITICAL;
    }
    if (topic.includes('governance') && status === 'deny') {
        return EVENT_SEVERITY.CRITICAL;
    }

    // Important: successes, approvals, deployments
    if (topic.includes('deploy') && (status === 'success' || topic.includes('.success'))) {
        return EVENT_SEVERITY.IMPORTANT;
    }
    if (topic.includes('governance') && (status === 'allow' || status === 'success')) {
        return EVENT_SEVERITY.IMPORTANT;
    }
    if (topic.includes('.success') || topic.includes('.approved')) {
        return EVENT_SEVERITY.IMPORTANT;
    }

    // Low: heartbeat, ping, routine checks
    if (topic.includes('heartbeat') || topic.includes('ping') || topic.includes('health')) {
        return EVENT_SEVERITY.LOW;
    }

    // Default: info level
    return EVENT_SEVERITY.INFO;
}

/**
 * VTID-0600: Format event timestamp for display
 */
function formatEventTimestamp(isoString) {
    if (!isoString) return 'N/A';
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/**
 * VTID-0600: Fetch OASIS events from the API
 * @param {Object} filters - Optional filters (topic, service, status)
 */
async function fetchOasisEvents(filters) {
    console.log('[VTID-0600] Fetching OASIS events...');
    state.oasisEvents.loading = true;
    renderApp();

    try {
        var queryParams = 'limit=100';
        if (filters) {
            if (filters.topic) queryParams += '&topic=like.*' + encodeURIComponent(filters.topic) + '*';
            if (filters.service) queryParams += '&service=eq.' + encodeURIComponent(filters.service);
            if (filters.status) queryParams += '&status=eq.' + encodeURIComponent(filters.status);
        }

        const response = await fetch('/api/v1/oasis/events?' + queryParams);
        if (!response.ok) {
            throw new Error('OASIS events fetch failed: ' + response.status);
        }

        const data = await response.json();
        console.log('[VTID-0600] OASIS events loaded:', data.length);

        state.oasisEvents.items = Array.isArray(data) ? data : [];
        state.oasisEvents.error = null;
        state.oasisEvents.fetched = true;
    } catch (error) {
        console.error('[VTID-0600] Failed to fetch OASIS events:', error);
        state.oasisEvents.error = error.message;
        state.oasisEvents.items = [];
    } finally {
        state.oasisEvents.loading = false;
        renderApp();
    }
}

/**
 * VTID-0600: Start auto-refresh for OASIS events (5 second interval)
 */
function startOasisEventsAutoRefresh() {
    if (state.oasisEvents.autoRefreshInterval) {
        clearInterval(state.oasisEvents.autoRefreshInterval);
    }
    state.oasisEvents.autoRefreshEnabled = true;
    state.oasisEvents.autoRefreshInterval = setInterval(function() {
        if (state.oasisEvents.autoRefreshEnabled) {
            fetchOasisEvents(state.oasisEvents.filters);
        }
    }, 5000);
    console.log('[VTID-0600] OASIS events auto-refresh started (5s interval)');
}

/**
 * VTID-0600: Stop auto-refresh for OASIS events
 */
function stopOasisEventsAutoRefresh() {
    if (state.oasisEvents.autoRefreshInterval) {
        clearInterval(state.oasisEvents.autoRefreshInterval);
        state.oasisEvents.autoRefreshInterval = null;
    }
    state.oasisEvents.autoRefreshEnabled = false;
    console.log('[VTID-0600] OASIS events auto-refresh stopped');
}

/**
 * VTID-0600: Fetch Command Hub Events (filtered operational events)
 * Only fetches events relevant to supervision: deploy.*, governance.*, cicd.*, autopilot.*
 */
async function fetchCommandHubEvents() {
    console.log('[VTID-0600] Fetching Command Hub events...');
    state.commandHubEvents.loading = true;
    renderApp();

    try {
        const response = await fetch('/api/v1/oasis/events?limit=100');
        if (!response.ok) {
            throw new Error('Command Hub events fetch failed: ' + response.status);
        }

        const data = await response.json();
        var allEvents = Array.isArray(data) ? data : [];

        // Filter to operational events only
        var operationalTopics = ['deploy', 'governance', 'cicd', 'autopilot', 'operator'];
        var filteredEvents = allEvents.filter(function(event) {
            var topic = (event.topic || '').toLowerCase();
            return operationalTopics.some(function(prefix) {
                return topic.startsWith(prefix);
            });
        });

        // Apply additional filters from state
        if (state.commandHubEvents.filters.topic) {
            var topicFilter = state.commandHubEvents.filters.topic.toLowerCase();
            filteredEvents = filteredEvents.filter(function(e) {
                return (e.topic || '').toLowerCase().includes(topicFilter);
            });
        }
        if (state.commandHubEvents.filters.service) {
            filteredEvents = filteredEvents.filter(function(e) {
                return e.service === state.commandHubEvents.filters.service;
            });
        }
        if (state.commandHubEvents.filters.status) {
            filteredEvents = filteredEvents.filter(function(e) {
                return e.status === state.commandHubEvents.filters.status;
            });
        }

        console.log('[VTID-0600] Command Hub events filtered:', filteredEvents.length);
        state.commandHubEvents.items = filteredEvents;
        state.commandHubEvents.error = null;
        state.commandHubEvents.fetched = true;
    } catch (error) {
        console.error('[VTID-0600] Failed to fetch Command Hub events:', error);
        state.commandHubEvents.error = error.message;
        state.commandHubEvents.items = [];
    } finally {
        state.commandHubEvents.loading = false;
        renderApp();
    }
}

/**
 * VTID-0600: Fetch VTIDs list from OASIS events
 * Groups events by VTID to show lifecycle overview
 */
async function fetchVtidsList() {
    console.log('[VTID-0600] Fetching VTIDs list...');
    state.vtidsList.loading = true;
    renderApp();

    try {
        const response = await fetch('/api/v1/oasis/events?limit=200');
        if (!response.ok) {
            throw new Error('VTIDs list fetch failed: ' + response.status);
        }

        const data = await response.json();
        var events = Array.isArray(data) ? data : [];

        // Group events by VTID
        var vtidMap = {};
        events.forEach(function(event) {
            if (!event.vtid) return;

            if (!vtidMap[event.vtid]) {
                vtidMap[event.vtid] = {
                    vtid: event.vtid,
                    layer: extractLayer(event.vtid),
                    status: 'PL', // default to PLANNER
                    events: [],
                    latestEvent: null,
                    services: new Set()
                };
            }

            vtidMap[event.vtid].events.push(event);
            if (event.service) {
                vtidMap[event.vtid].services.add(event.service);
            }

            // Update latest event
            if (!vtidMap[event.vtid].latestEvent ||
                new Date(event.created_at) > new Date(vtidMap[event.vtid].latestEvent.created_at)) {
                vtidMap[event.vtid].latestEvent = event;
            }

            // Determine status from event topic/stage
            var topic = (event.topic || '').toLowerCase();
            var stage = (event.task_stage || '').toUpperCase();
            if (stage === 'DEPLOY' || topic.includes('deploy')) {
                vtidMap[event.vtid].status = 'DE';
            } else if (stage === 'VALIDATOR' || topic.includes('validat')) {
                if (vtidMap[event.vtid].status !== 'DE') {
                    vtidMap[event.vtid].status = 'VA';
                }
            } else if (stage === 'WORKER' || topic.includes('work')) {
                if (vtidMap[event.vtid].status !== 'DE' && vtidMap[event.vtid].status !== 'VA') {
                    vtidMap[event.vtid].status = 'WO';
                }
            }
        });

        // Convert to array and sort by latest event
        var vtidList = Object.values(vtidMap);
        vtidList.forEach(function(v) {
            v.services = Array.from(v.services);
        });
        vtidList.sort(function(a, b) {
            var aTime = a.latestEvent ? new Date(a.latestEvent.created_at) : new Date(0);
            var bTime = b.latestEvent ? new Date(b.latestEvent.created_at) : new Date(0);
            return bTime - aTime;
        });

        console.log('[VTID-0600] VTIDs list generated:', vtidList.length);
        state.vtidsList.items = vtidList;
        state.vtidsList.error = null;
        state.vtidsList.fetched = true;
    } catch (error) {
        console.error('[VTID-0600] Failed to fetch VTIDs list:', error);
        state.vtidsList.error = error.message;
        state.vtidsList.items = [];
    } finally {
        state.vtidsList.loading = false;
        renderApp();
    }
}

/**
 * VTID-0600: Extract layer from VTID (DEV, CICD, GOV, ADM, etc.)
 */
function extractLayer(vtid) {
    if (!vtid) return 'UNK';
    var parts = vtid.split('-');
    if (parts.length >= 2) {
        // Check for known prefixes
        var prefix = parts[0].toUpperCase();
        if (prefix === 'VTID' && parts.length >= 2) {
            // Try to infer from number range
            var num = parseInt(parts[1], 10);
            if (num >= 100 && num < 200) return 'GOV';
            if (num >= 200 && num < 300) return 'DEV';
            if (num >= 400 && num < 500) return 'GOV';
            if (num >= 500 && num < 600) return 'DEV';
            if (num >= 600 && num < 700) return 'ADM';
            return 'DEV';
        }
        return prefix;
    }
    return 'UNK';
}

/**
 * DEV-COMHU-2025-0008: Fetch VTIDs from authoritative ledger API.
 * Uses GET /api/v1/vtid/list - the canonical source of truth for VTIDs.
 * Shows ledger-only VTIDs (0 events) immediately in UI.
 */
const VTID_LEDGER_LIMIT = 50;

async function fetchVtidLedger() {
    console.log('[DEV-COMHU-2025-0008] Fetching VTID ledger...');
    state.vtidLedger.loading = true;
    state.vtidLedger.error = null;
    renderApp();

    try {
        var response = await fetch('/api/v1/vtid/list?limit=' + VTID_LEDGER_LIMIT);
        if (!response.ok) {
            throw new Error('VTID ledger fetch failed: ' + response.status);
        }

        var data = await response.json();

        // Handle both array and wrapped response formats
        var items = [];
        if (Array.isArray(data)) {
            items = data;
        } else if (data && Array.isArray(data.items)) {
            items = data.items;
        } else if (data && Array.isArray(data.vtids)) {
            items = data.vtids;
        } else {
            console.warn('[DEV-COMHU-2025-0008] Unexpected response format:', data);
            items = [];
        }

        console.log('[DEV-COMHU-2025-0008] VTID ledger loaded:', items.length, 'VTIDs');
        state.vtidLedger.items = items;
        state.vtidLedger.error = null;
        state.vtidLedger.fetched = true;
    } catch (error) {
        console.error('[DEV-COMHU-2025-0008] Failed to fetch VTID ledger:', error);
        state.vtidLedger.error = error.message;
        state.vtidLedger.items = [];
    } finally {
        state.vtidLedger.loading = false;
        renderApp();
    }
}

/**
 * VTID-0601: Fetch approvals from CICD API
 */
async function fetchApprovals() {
    console.log('[VTID-0601] Fetching approvals...');
    state.approvals.loading = true;
    state.approvals.error = null;
    renderApp();

    try {
        var response = await fetch('/api/v1/cicd/approvals');
        var data = await response.json();

        if (data.ok) {
            state.approvals.items = data.approvals || [];
            state.approvals.error = null;
            console.log('[VTID-0601] Approvals loaded:', state.approvals.items.length, 'items');
        } else {
            state.approvals.items = [];
            state.approvals.error = data.error || 'Failed to fetch approvals';
            console.error('[VTID-0601] Approvals fetch error:', state.approvals.error);
        }
    } catch (err) {
        state.approvals.items = [];
        state.approvals.error = err.message || 'Network error';
        console.error('[VTID-0601] Approvals fetch exception:', err);
    }

    state.approvals.loading = false;
    state.approvals.fetched = true;
    renderApp();
}

/**
 * VTID-0601: Approve an approval item (merge + optional deploy)
 */
async function approveApprovalItem(approvalId) {
    console.log('[VTID-0601] Approving item:', approvalId);
    state.approvals.loading = true;
    renderApp();

    try {
        var response = await fetch('/api/v1/cicd/approvals/' + approvalId + '/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        var data = await response.json();

        if (data.ok) {
            showToast('Approval executed successfully! PR merged' + (data.deploy ? ' and deploy triggered.' : '.'), 'success');
            // Refresh approvals list
            state.approvals.fetched = false;
            await fetchApprovals();
        } else {
            showToast('Approval failed: ' + (data.error || 'Unknown error'), 'error');
            state.approvals.loading = false;
            renderApp();
        }
    } catch (err) {
        showToast('Approval failed: ' + err.message, 'error');
        state.approvals.loading = false;
        renderApp();
    }
}

/**
 * VTID-0601: Deny an approval item
 */
async function denyApprovalItem(approvalId, reason) {
    console.log('[VTID-0601] Denying item:', approvalId);
    state.approvals.loading = true;
    renderApp();

    try {
        var response = await fetch('/api/v1/cicd/approvals/' + approvalId + '/deny', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason || 'Denied by user' })
        });
        var data = await response.json();

        if (data.ok) {
            showToast('Approval denied.', 'info');
            // Refresh approvals list
            state.approvals.fetched = false;
            await fetchApprovals();
        } else {
            showToast('Denial failed: ' + (data.error || 'Unknown error'), 'error');
            state.approvals.loading = false;
            renderApp();
        }
    } catch (err) {
        showToast('Denial failed: ' + err.message, 'error');
        state.approvals.loading = false;
        renderApp();
    }
}

/**
 * VTID-0600: Generate human-readable summary from deployment data
 * Extracts meaning from VTID, service, and status
 */
function generateDeploySummary(deploy) {
    var service = deploy.service || 'unknown service';
    var vtid = deploy.vtid || '';
    var status = deploy.status || 'unknown';

    // Try to extract meaning from VTID pattern
    var meaning = '';

    if (vtid.includes('-0600')) {
        meaning = 'Operational visibility foundation';
    } else if (vtid.includes('-0500') || vtid.includes('-05')) {
        meaning = 'Core infrastructure update';
    } else if (vtid.includes('-0400') || vtid.includes('-04')) {
        meaning = 'Governance system change';
    } else if (vtid.includes('-0300') || vtid.includes('-03')) {
        meaning = 'Agent pipeline update';
    } else if (vtid.includes('-0200') || vtid.includes('-02')) {
        meaning = 'API/Integration change';
    } else if (vtid.includes('-0100') || vtid.includes('-01')) {
        meaning = 'Foundation layer update';
    }

    // Generate summary based on available data
    if (status === 'success') {
        if (meaning) {
            return 'Deployed ' + meaning + ' to ' + service;
        }
        return 'Successful deployment to ' + service;
    } else if (status === 'failure') {
        if (meaning) {
            return 'Failed: ' + meaning + ' for ' + service;
        }
        return 'Deployment failed for ' + service;
    } else {
        if (meaning) {
            return meaning + ' (' + service + ')';
        }
        return 'Update to ' + service;
    }
}

// --- Version History Data Model (VTID-0517 + VTID-0524) ---

/**
 * Version status constants for deployment entries.
 * @enum {string}
 */
const VersionStatus = {
    SUCCESS: 'success',
    FAILURE: 'failure',
    LIVE: 'live',
    DRAFT: 'draft',
    UNPUBLISHED: 'unpublished',
    UNKNOWN: 'unknown'
};

/**
 * VTID-0524: Fetches deployment history from the canonical API endpoint.
 * Returns deployment entries with VTID + SWV correlation.
 *
 * VTID-0525-B: Fixed to handle plain array response from API.
 * The API returns a plain array, not {ok: true, deployments: [...]}
 *
 * @returns {Promise<Array<{id: string, vtid: string|null, swv: string, label: string, status: string, createdAt: string, service: string, environment: string, commit: string}>>}
 */
async function fetchDeploymentHistory() {
    console.log('[VTID-0524] Fetching deployment history...');

    try {
        const response = await fetch('/api/v1/operator/deployments?limit=50');
        if (!response.ok) {
            throw new Error('Deployment history fetch failed: ' + response.status);
        }

        const data = await response.json();
        console.log('[VTID-0524] Deployment history loaded:', data);

        // VTID-0525-B: Handle both plain array and wrapped response formats
        // API returns plain array: [{swv_id, service, ...}, ...]
        // Previously expected: {ok: true, deployments: [...]}
        var deployments = [];
        if (Array.isArray(data)) {
            // Plain array response (current API format)
            deployments = data;
        } else if (data && Array.isArray(data.deployments)) {
            // Wrapped response format (legacy)
            deployments = data.deployments;
        } else if (data && Array.isArray(data.details)) {
            // Alternative wrapped format
            deployments = data.details;
        } else {
            console.warn('[VTID-0524] Unexpected response format:', data);
            return [];
        }

        if (deployments.length === 0) {
            console.log('[VTID-0524] No deployments found');
            return [];
        }

        // Map API response to version history format
        // API returns: swv_id, service, git_commit, status, initiator, deploy_type, environment, created_at
        return deployments.map(function(d, index) {
            return {
                id: 'deploy-' + (d.swv_id || d.swv || index),
                vtid: d.vtid || null,
                swv: d.swv_id || d.swv || 'unknown',
                label: d.service + ' ' + (d.swv_id || d.swv || ''),
                status: d.status || VersionStatus.UNKNOWN,
                createdAt: d.created_at,
                service: d.service,
                environment: d.environment,
                commit: d.git_commit || d.commit
            };
        });
    } catch (error) {
        console.error('[VTID-0524] Failed to fetch deployment history:', error);
        return [];
    }
}

/**
 * Loads version history entries.
 * VTID-0524: Now returns cached version history or empty array.
 * Use fetchDeploymentHistory() to refresh from API.
 *
 * @returns {Array}
 */
function loadVersionHistory() {
    // Return current state (populated by fetchDeploymentHistory)
    return state.versionHistory || [];
}

/**
 * Formats an ISO timestamp into a human-readable string.
 * @param {string} isoString - ISO 8601 timestamp
 * @returns {string} Formatted date string (e.g., "Nov 28, 8:14 AM")
 */
function formatVersionTimestamp(isoString) {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
    }) + ', ' + date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

// --- Toast Notification System (VTID-0517) ---

let toastIdCounter = 0;

/**
 * Shows a toast notification.
 * @param {string} message - The message to display
 * @param {string} type - Toast type: 'info', 'success', 'error'
 * @param {number} duration - Duration in milliseconds (default: 4000)
 */
function showToast(message, type = 'info', duration = 4000) {
    const id = ++toastIdCounter;
    state.toasts.push({ id, message, type });
    renderApp();

    // Auto-dismiss after duration
    setTimeout(() => {
        state.toasts = state.toasts.filter(t => t.id !== id);
        renderApp();
    }, duration);
}

// --- DOM Elements & Rendering ---

function renderApp() {
    const root = document.getElementById('root');

    // VTID-0526-E: Save chat textarea focus state before destroying DOM
    var chatTextarea = document.querySelector('.chat-textarea');
    var savedChatFocus = null;
    if (chatTextarea && document.activeElement === chatTextarea) {
        savedChatFocus = {
            value: chatTextarea.value,
            selectionStart: chatTextarea.selectionStart,
            selectionEnd: chatTextarea.selectionEnd
        };
    }

    // VTID-0539: Save chat scroll position for scroll anchoring
    var messagesContainer = document.querySelector('.chat-messages');
    var savedChatScroll = null;
    if (messagesContainer) {
        var scrollTop = messagesContainer.scrollTop;
        var scrollHeight = messagesContainer.scrollHeight;
        var clientHeight = messagesContainer.clientHeight;
        var distanceFromBottom = scrollHeight - scrollTop - clientHeight;
        savedChatScroll = {
            scrollTop: scrollTop,
            wasNearBottom: distanceFromBottom <= 80, // Within 80px of bottom
            previousScrollHeight: scrollHeight
        };
    }

    root.innerHTML = '';

    const container = document.createElement('div');
    container.className = 'app-container';

    container.appendChild(renderSidebar());

    const mainContent = document.createElement('div');
    mainContent.className = 'main-content';

    mainContent.appendChild(renderHeader());

    if (state.isSplitScreen) {
        mainContent.appendChild(renderSplitScreen());
    } else {
        mainContent.appendChild(renderMainContent());
    }

    container.appendChild(mainContent);
    root.appendChild(container);

    // Drawer
    root.appendChild(renderTaskDrawer());

    // VTID-0401: Governance Rule Detail Drawer
    root.appendChild(renderGovernanceRuleDetailDrawer());

    // VTID-0600: OASIS Event Detail Drawer
    root.appendChild(renderOasisEventDrawer());

    // Modals
    if (state.showProfileModal) root.appendChild(renderProfileModal());
    if (state.showTaskModal) root.appendChild(renderTaskModal());

    // Global Overlays (VTID-0508)
    if (state.isHeartbeatOpen) root.appendChild(renderHeartbeatOverlay());
    if (state.isOperatorOpen) root.appendChild(renderOperatorOverlay());

    // Publish Modal (VTID-0517)
    if (state.showPublishModal) root.appendChild(renderPublishModal());

    // VTID-0407: Governance Blocked Modal
    if (state.showGovernanceBlockedModal) root.appendChild(renderGovernanceBlockedModal());

    // Toast Notifications (VTID-0517)
    if (state.toasts.length > 0) root.appendChild(renderToastContainer());

    // VTID-0529-B: Hard bundle fingerprint - banner at top, footer at bottom-right
    root.appendChild(renderBundleFingerprintBanner());
    root.appendChild(renderBundleFingerprintFooter());

    // VTID-0150-A: ORB UI & Interaction Shell (Global Assistant Overlay)
    // Note: ORB idle is now rendered inside sidebar footer via renderOrbIdleElement()
    root.appendChild(renderOrbOverlay());
    root.appendChild(renderOrbChatDrawer());

    // VTID-0526-E: Restore chat textarea focus after render
    if (savedChatFocus) {
        requestAnimationFrame(function() {
            var newTextarea = document.querySelector('.chat-textarea');
            if (newTextarea) {
                newTextarea.focus();
                // Restore cursor position
                newTextarea.setSelectionRange(savedChatFocus.selectionStart, savedChatFocus.selectionEnd);
            }
        });
    }

    // VTID-0539: Scroll anchoring - preserve scroll position or scroll to bottom based on user's position
    // Only auto-scroll if user was near bottom; otherwise preserve their scroll position
    if (state.isOperatorOpen && state.operatorActiveTab === 'chat' && !savedChatFocus) {
        requestAnimationFrame(function() {
            var newMessagesContainer = document.querySelector('.chat-messages');
            if (newMessagesContainer && savedChatScroll) {
                if (savedChatScroll.wasNearBottom) {
                    // User was at/near bottom - scroll to show new messages
                    newMessagesContainer.scrollTop = newMessagesContainer.scrollHeight;
                } else {
                    // User had scrolled up - preserve their position relative to content
                    // Adjust for any new content added at bottom
                    var newScrollHeight = newMessagesContainer.scrollHeight;
                    var heightDiff = newScrollHeight - savedChatScroll.previousScrollHeight;
                    // Keep the same scrollTop (content added below their view)
                    newMessagesContainer.scrollTop = savedChatScroll.scrollTop;
                }
            } else if (newMessagesContainer) {
                // No previous scroll state (first render) - scroll to bottom
                newMessagesContainer.scrollTop = newMessagesContainer.scrollHeight;
            }
        });
    }
}

function renderSidebar() {
    const sidebar = document.createElement('div');
    sidebar.className = `sidebar ${state.sidebarCollapsed ? 'collapsed' : ''}`;

    // Brand (VTID-0508)
    const brand = document.createElement('div');
    brand.className = 'sidebar-brand';
    if (state.sidebarCollapsed) {
        brand.textContent = 'VD';
    } else {
        brand.innerHTML = 'VITANA DEV';
    }
    sidebar.appendChild(brand);

    // Modules
    const navSection = document.createElement('div');
    navSection.className = 'nav-section';

    NAVIGATION_CONFIG.forEach(mod => {
        const label = SECTION_LABELS[mod.section] || mod.section;
        const item = document.createElement('div');
        item.className = `nav-item ${state.currentModuleKey === mod.section ? 'active' : ''}`;
        item.dataset.module = label; // For Operator accent
        item.textContent = state.sidebarCollapsed ? label.substring(0, 2) : label;
        item.title = label;
        item.onclick = () => handleModuleClick(mod.section);
        navSection.appendChild(item);
    });

    sidebar.appendChild(navSection);

    // Sidebar Footer: Profile + ORB (VTID-0150-A)
    const sidebarFooter = document.createElement('div');
    sidebarFooter.className = 'sidebar-footer';

    // Profile capsule (VTID-0508)
    const profile = document.createElement('div');
    profile.className = 'sidebar-profile';
    profile.onclick = () => {
        state.showProfileModal = true;
        renderApp();
    };

    const avatar = document.createElement('div');
    avatar.className = 'sidebar-profile-avatar';
    avatar.textContent = state.user.avatar;
    profile.appendChild(avatar);

    if (!state.sidebarCollapsed) {
        const info = document.createElement('div');
        info.className = 'sidebar-profile-info';

        const name = document.createElement('div');
        name.className = 'sidebar-profile-name';
        name.textContent = state.user.name;
        info.appendChild(name);

        const role = document.createElement('div');
        role.className = 'sidebar-profile-role';
        role.textContent = state.user.role;
        info.appendChild(role);

        profile.appendChild(info);
    }

    sidebarFooter.appendChild(profile);

    // ORB container (centered) - VTID-0150-A
    const orbContainer = document.createElement('div');
    orbContainer.className = 'sidebar-orb-container';
    orbContainer.appendChild(renderOrbIdleElement());
    sidebarFooter.appendChild(orbContainer);

    sidebar.appendChild(sidebarFooter);

    // Toggle
    const toggle = document.createElement('div');
    toggle.className = 'collapse-toggle';
    toggle.innerHTML = state.sidebarCollapsed ? '&raquo;' : '&laquo;';
    toggle.onclick = () => {
        state.sidebarCollapsed = !state.sidebarCollapsed;
        renderApp();
    };
    sidebar.appendChild(toggle);

    return sidebar;
}

/**
 * VTID-0150-A: Creates the ORB idle element for the sidebar footer
 * @returns {HTMLElement}
 */
function renderOrbIdleElement() {
    var orb = document.createElement('div');
    orb.className = 'orb-idle orb-idle-pulse' + (state.orb.overlayVisible ? ' orb-hidden' : '');
    orb.setAttribute('role', 'button');
    orb.setAttribute('aria-label', 'Open Vitana Assistant');
    orb.setAttribute('tabindex', '0');

    // Click handler
    orb.addEventListener('click', function() {
        console.log('[ORB] Opening overlay...');
        state.orb.overlayVisible = true;
        renderApp();
    });

    // Keyboard accessibility
    orb.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            state.orb.overlayVisible = true;
            renderApp();
        }
    });

    return orb;
}

function renderHeader() {
    const header = document.createElement('div');
    header.className = 'header-toolbar';

    // --- Left Section: Autopilot, Operator, Clock (DEV-COMHU-2025-0010: Heartbeat removed) ---
    const left = document.createElement('div');
    left.className = 'header-toolbar-left';

    // 1. Autopilot pill (neutral styling, uppercase)
    const autopilotBtn = document.createElement('button');
    autopilotBtn.className = 'header-pill header-pill--neutral';
    autopilotBtn.textContent = 'AUTOPILOT';
    left.appendChild(autopilotBtn);

    // 2. Operator pill (same size as Autopilot, uppercase, orange accent)
    const operatorBtn = document.createElement('button');
    operatorBtn.className = 'header-pill header-pill--operator';
    operatorBtn.textContent = 'OPERATOR';
    operatorBtn.onclick = () => {
        state.operatorActiveTab = 'chat';
        state.isOperatorOpen = true;
        renderApp();

        // VTID-0526-B: Auto-start live ticker when opening Operator Console
        // This ensures events are streaming without requiring Heartbeat button click
        startOperatorLiveTicker();
    };
    left.appendChild(operatorBtn);

    // 3. Clock / Version History icon button (VTID-0524) - neutral color
    const versionBtn = document.createElement('button');
    versionBtn.className = 'header-icon-button';
    versionBtn.title = 'Version History';
    // Clock icon using Unicode character (CSP compliant)
    versionBtn.innerHTML = '<span class="header-icon-button__icon">&#128337;</span>';
    versionBtn.onclick = async (e) => {
        e.stopPropagation();
        state.isVersionDropdownOpen = !state.isVersionDropdownOpen;
        if (state.isVersionDropdownOpen) {
            // VTID-0524: Fetch version history from API when opening
            renderApp(); // Show dropdown immediately
            try {
                state.versionHistory = await fetchDeploymentHistory();
                renderApp();
            } catch (error) {
                console.error('[VTID-0524] Failed to fetch version history:', error);
            }
        } else {
            renderApp();
        }
    };
    left.appendChild(versionBtn);

    // Version History Dropdown (rendered within left for positioning)
    if (state.isVersionDropdownOpen) {
        left.appendChild(renderVersionDropdown());
    }

    header.appendChild(left);

    // --- Center Section: Empty (Publish moved to right) ---
    const center = document.createElement('div');
    center.className = 'header-toolbar-center';
    header.appendChild(center);

    // --- Right Section: Publish + LIVE/OFFLINE with CI/CD dropdown ---
    const right = document.createElement('div');
    right.className = 'header-toolbar-right';

    // Publish pill (LEFT of LIVE, same size as LIVE/OFFLINE)
    const publishBtn = document.createElement('button');
    publishBtn.className = 'header-pill header-pill--publish';
    publishBtn.textContent = 'PUBLISH';
    publishBtn.onclick = async () => {
        state.showPublishModal = true;
        renderApp(); // Show modal immediately with loading state

        // Fetch version history if not already loaded
        if (!state.versionHistory || state.versionHistory.length === 0) {
            try {
                console.log('[VTID-0523-B] Fetching version history for publish modal');
                state.versionHistory = await fetchDeploymentHistory();
                renderApp(); // Re-render with loaded versions
            } catch (error) {
                console.error('[VTID-0523-B] Failed to fetch version history:', error);
            }
        }
    };
    right.appendChild(publishBtn);

    // LIVE/OFFLINE pill with CI/CD dropdown (restored from pre-0010)
    const hasStageCounters = state.stageCounters && (state.stageCounters.PLANNER > 0 || state.stageCounters.WORKER > 0 || state.stageCounters.VALIDATOR > 0 || state.stageCounters.DEPLOY > 0 || state.lastTelemetryRefresh);
    const isLive = state.operatorHeartbeatActive || hasStageCounters;

    // CI/CD Health Indicator container (holds pill + dropdown)
    const cicdHealthIndicator = document.createElement('div');
    cicdHealthIndicator.className = 'cicd-health-indicator';

    // VTID-0541 D4: Determine health status with proper distinction
    const healthStatus = state.cicdHealth?.status;
    const isFullyHealthy = state.cicdHealth && state.cicdHealth.ok === true && healthStatus === 'ok';
    const isGovernanceLimited = healthStatus === 'ok_governance_limited';
    const isDegraded = healthStatus === 'degraded' || (state.cicdHealth && state.cicdHealth.ok === false);

    // LIVE/OFFLINE status pill (clickable to show CI/CD dropdown)
    const statusPill = document.createElement('button');
    if (isLive) {
        statusPill.className = 'header-pill header-pill--live';
        statusPill.innerHTML = '<span class="header-pill__dot"></span>LIVE';
    } else {
        statusPill.className = 'header-pill header-pill--offline';
        statusPill.innerHTML = '<span class="header-pill__dot"></span>OFFLINE';
    }
    statusPill.onclick = (e) => {
        e.stopPropagation();
        state.cicdHealthTooltipOpen = !state.cicdHealthTooltipOpen;
        renderApp();
    };
    cicdHealthIndicator.appendChild(statusPill);

    // CI/CD Health Tooltip/Dropdown (restored from pre-0010)
    if (state.cicdHealthTooltipOpen) {
        const tooltip = document.createElement('div');
        tooltip.className = 'cicd-health-tooltip';

        // Header - VTID-0541 D4: Show proper status distinction
        const tooltipHeader = document.createElement('div');
        tooltipHeader.className = 'cicd-health-tooltip__header';
        if (isDegraded) {
            tooltipHeader.innerHTML = '<span class="cicd-health-tooltip__status cicd-health-tooltip__status--error">&#9829; CI/CD Degraded</span>';
        } else if (isGovernanceLimited) {
            tooltipHeader.innerHTML = '<span class="cicd-health-tooltip__status cicd-health-tooltip__status--warning">&#9829; CI/CD OK (Governance Limited)</span>';
        } else if (isFullyHealthy) {
            tooltipHeader.innerHTML = '<span class="cicd-health-tooltip__status cicd-health-tooltip__status--healthy">&#9829; CI/CD Healthy</span>';
        } else {
            tooltipHeader.innerHTML = '<span class="cicd-health-tooltip__status">&#9829; CI/CD Status</span>';
        }
        tooltip.appendChild(tooltipHeader);

        // Status details
        if (state.cicdHealth) {
            const details = document.createElement('div');
            details.className = 'cicd-health-tooltip__details';

            // Status line
            const statusLine = document.createElement('div');
            statusLine.className = 'cicd-health-tooltip__row';
            statusLine.innerHTML = '<span class="cicd-health-tooltip__label">Status:</span>' +
                '<span class="cicd-health-tooltip__value">' + (state.cicdHealth.status || 'unknown') + '</span>';
            details.appendChild(statusLine);

            // Capabilities
            if (state.cicdHealth.capabilities) {
                const capsHeader = document.createElement('div');
                capsHeader.className = 'cicd-health-tooltip__caps-header';
                capsHeader.textContent = 'Capabilities';
                details.appendChild(capsHeader);

                for (const [key, value] of Object.entries(state.cicdHealth.capabilities)) {
                    const capRow = document.createElement('div');
                    capRow.className = 'cicd-health-tooltip__row';
                    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                    capRow.innerHTML = '<span class="cicd-health-tooltip__label">' + label + ':</span>' +
                        '<span class="cicd-health-tooltip__value cicd-health-tooltip__value--' + (value ? 'yes' : 'no') + '">' +
                        (value ? 'Yes' : 'No') + '</span>';
                    details.appendChild(capRow);
                }
            }

            tooltip.appendChild(details);
        } else if (state.cicdHealthError) {
            const errorDetails = document.createElement('div');
            errorDetails.className = 'cicd-health-tooltip__error';
            errorDetails.textContent = 'Error: ' + state.cicdHealthError;
            tooltip.appendChild(errorDetails);
        } else {
            const loadingDetails = document.createElement('div');
            loadingDetails.className = 'cicd-health-tooltip__loading';
            loadingDetails.textContent = 'Loading...';
            tooltip.appendChild(loadingDetails);
        }

        // Last updated timestamp
        const footer = document.createElement('div');
        footer.className = 'cicd-health-tooltip__footer';
        footer.textContent = 'Updated: ' + new Date().toLocaleTimeString();
        tooltip.appendChild(footer);

        cicdHealthIndicator.appendChild(tooltip);

        // Click-outside handler for CI/CD tooltip
        setTimeout(() => {
            const closeTooltip = (e) => {
                const tooltipEl = document.querySelector('.cicd-health-tooltip');
                const pillEl = document.querySelector('.header-pill--live, .header-pill--offline');
                if (tooltipEl && !tooltipEl.contains(e.target) && pillEl && !pillEl.contains(e.target)) {
                    state.cicdHealthTooltipOpen = false;
                    document.removeEventListener('click', closeTooltip);
                    renderApp();
                }
            };
            document.addEventListener('click', closeTooltip);
        }, 0);
    }

    right.appendChild(cicdHealthIndicator);
    header.appendChild(right);

    // Add click-outside handler for version dropdown
    if (state.isVersionDropdownOpen) {
        setTimeout(() => {
            const closeDropdown = (e) => {
                const dropdown = document.querySelector('.version-dropdown');
                const iconBtn = document.querySelector('.header-icon-button');
                if (dropdown && !dropdown.contains(e.target) && !iconBtn.contains(e.target)) {
                    state.isVersionDropdownOpen = false;
                    document.removeEventListener('click', closeDropdown);
                    renderApp();
                }
            };
            document.addEventListener('click', closeDropdown);
        }, 0);
    }

    return header;
}

// --- Version History Dropdown (VTID-0517 + VTID-0524) ---

/**
 * VTID-0524: Renders version history dropdown with deployments from API
 * - Most recent on top
 * - Shows SWV label
 * - Hover/tooltip shows VTID + timestamp
 */
function renderVersionDropdown() {
    const dropdown = document.createElement('div');
    dropdown.className = 'version-dropdown';

    // Header
    const dropdownHeader = document.createElement('div');
    dropdownHeader.className = 'version-dropdown__title';
    dropdownHeader.textContent = 'Versions';
    dropdown.appendChild(dropdownHeader);

    // List container
    const list = document.createElement('div');
    list.className = 'version-dropdown__list';

    // Show loading state if no data yet
    if (!state.versionHistory || state.versionHistory.length === 0) {
        const emptyItem = document.createElement('div');
        emptyItem.className = 'version-dropdown__item version-dropdown__item--empty';
        emptyItem.textContent = 'Loading deployments...';
        list.appendChild(emptyItem);
    } else {
        // VTID-0524: Render deployments (already sorted by created_at DESC from API)
        state.versionHistory.forEach(function(version) {
            const item = document.createElement('div');
            item.className = 'version-dropdown__item';
            if (state.selectedVersionId === version.id) {
                item.className += ' version-dropdown__item--selected';
            }

            // VTID-0524: Build tooltip with VTID + timestamp
            const tooltipParts = [];
            if (version.vtid) {
                tooltipParts.push(version.vtid);
            }
            if (version.createdAt) {
                tooltipParts.push(new Date(version.createdAt).toLocaleString());
            }
            if (version.commit) {
                tooltipParts.push('Commit: ' + version.commit);
            }
            item.title = tooltipParts.join(' | ');

            // Primary label: SWV + service
            const label = document.createElement('div');
            label.className = 'version-dropdown__item-label';
            label.textContent = version.swv + ' – ' + (version.service || 'unknown');
            item.appendChild(label);

            // Meta line: timestamp + status badge
            const meta = document.createElement('div');
            meta.className = 'version-dropdown__item-meta';

            const timestamp = document.createElement('span');
            timestamp.className = 'version-dropdown__item-timestamp';
            timestamp.textContent = version.createdAt ? formatVersionTimestamp(version.createdAt) : '';
            meta.appendChild(timestamp);

            if (version.status) {
                const badge = document.createElement('span');
                // VTID-0524: Map status to badge classes
                let badgeClass = 'version-dropdown__item-badge';
                if (version.status === 'success') {
                    badgeClass += ' version-dropdown__item-badge--success';
                } else if (version.status === 'failure') {
                    badgeClass += ' version-dropdown__item-badge--failure';
                } else {
                    badgeClass += ' version-dropdown__item-badge--' + version.status;
                }
                badge.className = badgeClass;
                badge.textContent = version.status.charAt(0).toUpperCase() + version.status.slice(1);
                meta.appendChild(badge);
            }

            item.appendChild(meta);

            // Click handler
            item.onclick = function(e) {
                e.stopPropagation();
                state.selectedVersionId = version.id;
                const displayName = version.swv || version.vtid || version.label;
                showToast('Version ' + displayName + ' selected. Restore/publish flow will be implemented in a later step.', 'info');
                state.isVersionDropdownOpen = false;
                renderApp();
            };

            list.appendChild(item);
        });
    }

    dropdown.appendChild(list);
    return dropdown;
}

function renderMainContent() {
    const content = document.createElement('div');
    content.className = 'content-area';

    // Tabs
    const currentSection = NAVIGATION_CONFIG.find(s => s.section === state.currentModuleKey);
    const tabs = currentSection ? currentSection.tabs : [];

    if (tabs.length > 0) {
        const subNav = document.createElement('div');
        subNav.className = 'sub-nav';

        tabs.forEach(tab => {
            const tabEl = document.createElement('div');
            tabEl.className = `sub-nav-tab ${state.currentTab === tab.key ? 'active' : ''}`;
            tabEl.textContent = formatTabLabel(tab.key);
            tabEl.onclick = () => handleTabClick(tab.key);
            subNav.appendChild(tabEl);
        });

        content.appendChild(subNav);
    }

    // Module Content
    const moduleContent = document.createElement('div');
    moduleContent.className = 'module-content-wrapper';

    moduleContent.appendChild(renderModuleContent(state.currentModuleKey, state.currentTab));

    content.appendChild(moduleContent);

    return content;
}

function renderSplitScreen() {
    const split = document.createElement('div');
    split.className = 'split-screen';

    const left = document.createElement('div');
    left.className = 'split-panel-left';
    // Header for pane
    const leftHeader = document.createElement('div');
    leftHeader.className = 'split-pane-header';
    leftHeader.textContent = `${SECTION_LABELS[state.leftPane.module] || state.leftPane.module} > ${formatTabLabel(state.leftPane.tab)}`;
    left.appendChild(leftHeader);

    const leftContent = document.createElement('div');
    leftContent.className = 'split-pane-content';
    leftContent.appendChild(renderModuleContent(state.leftPane.module, state.leftPane.tab));
    left.appendChild(leftContent);

    split.appendChild(left);

    const divider = document.createElement('div');
    divider.className = 'split-divider';
    split.appendChild(divider);

    const right = document.createElement('div');
    right.className = 'split-panel-right';
    // Header for pane
    const rightHeader = document.createElement('div');
    rightHeader.className = 'split-pane-header';
    rightHeader.textContent = `${SECTION_LABELS[state.rightPane.module] || state.rightPane.module} > ${formatTabLabel(state.rightPane.tab)}`;
    right.appendChild(rightHeader);

    const rightContent = document.createElement('div');
    rightContent.className = 'split-pane-content';
    rightContent.appendChild(renderModuleContent(state.rightPane.module, state.rightPane.tab));
    right.appendChild(rightContent);

    split.appendChild(right);

    return split;
}

function renderModuleContent(moduleKey, tab) {
    const container = document.createElement('div');
    container.className = 'content-container';

    if (moduleKey === 'command-hub' && tab === 'tasks') {
        container.appendChild(renderTasksView());
    } else if (moduleKey === 'command-hub' && tab === 'events') {
        // VTID-0600: Command Hub Events (curated operational view)
        container.appendChild(renderCommandHubEventsView());
    } else if (moduleKey === 'command-hub' && tab === 'vtids') {
        // VTID-0600: VTIDs Lifecycle Overview
        container.appendChild(renderVtidsView());
    } else if (moduleKey === 'command-hub' && tab === 'approvals') {
        // VTID-0600: Approvals UI Scaffolding
        container.appendChild(renderApprovalsView());
    } else if (moduleKey === 'oasis' && tab === 'events') {
        // VTID-0600: OASIS Events View
        container.appendChild(renderOasisEventsView());
    } else if (moduleKey === 'oasis' && tab === 'vtid-ledger') {
        // DEV-COMHU-2025-0008: OASIS VTID Ledger View
        container.appendChild(renderOasisVtidLedgerView());
    } else if (moduleKey === 'docs' && tab === 'screens') {
        container.appendChild(renderDocsScreensView());
    } else if (moduleKey === 'governance' && tab === 'rules') {
        // VTID-0401: Governance Rules catalog view
        container.appendChild(renderGovernanceRulesView());
    } else if (moduleKey === 'governance' && tab === 'evaluations') {
        // VTID-0406: Governance Evaluations viewer (OASIS integration)
        container.appendChild(renderGovernanceEvaluationsView());
    } else if (moduleKey === 'governance' && tab === 'history') {
        // VTID-0408: Governance History timeline view
        container.appendChild(renderGovernanceHistoryView());
    } else if (moduleKey === 'governance' && tab === 'categories') {
        // VTID-0409: Governance Categories (Read-Only V1)
        container.appendChild(renderGovernanceCategoriesView());
    } else {
        // Placeholder for other modules
        const placeholder = document.createElement('div');
        placeholder.className = 'placeholder-content';

        if (moduleKey === 'command-hub' && tab === 'live-console') {
            placeholder.innerHTML = '<div class="placeholder-panel">Live Console placeholder</div>';
        } else {
            const sectionLabel = SECTION_LABELS[moduleKey] || moduleKey;
            const tabLabel = formatTabLabel(tab);
            placeholder.textContent = `${sectionLabel} > ${tabLabel || 'Overview'}`;
        }
        container.appendChild(placeholder);
    }
    return container;
}

function renderTasksView() {
    const container = document.createElement('div');
    container.className = 'tasks-container';

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'tasks-toolbar';

    const search = document.createElement('input');
    search.className = 'search-field';
    search.placeholder = 'Search tasks...';
    search.value = state.taskSearchQuery;
    search.oninput = (e) => {
        state.taskSearchQuery = e.target.value;
        renderApp();
    };
    toolbar.appendChild(search);

    const dateFilter = document.createElement('input');
    dateFilter.type = 'date';
    dateFilter.className = 'form-control date-filter-input';
    dateFilter.value = state.taskDateFilter;
    dateFilter.onchange = (e) => {
        state.taskDateFilter = e.target.value;
        renderApp();
    };
    toolbar.appendChild(dateFilter);

    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    toolbar.appendChild(spacer);

    const newBtn = document.createElement('button');
    newBtn.className = 'btn btn-primary';
    newBtn.textContent = '+ New Task';
    newBtn.onclick = () => {
        state.showTaskModal = true;
        renderApp();
    };
    toolbar.appendChild(newBtn);

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn refresh-btn-margin';
    refreshBtn.textContent = '↻';
    refreshBtn.onclick = () => {
        fetchTasks();
        // VTID-0527: Also refresh telemetry for stage timelines
        fetchTelemetrySnapshot();
    };
    toolbar.appendChild(refreshBtn);

    container.appendChild(toolbar);

    // Golden Task Board
    const board = document.createElement('div');
    board.className = 'task-board';

    if (state.tasksLoading) {
        board.innerHTML = '<div class="placeholder-content">Loading tasks...</div>';
        container.appendChild(board);
        return container;
    }

    if (state.tasksError) {
        board.innerHTML = `<div class="placeholder-content error-text">Error: ${state.tasksError}</div>`;
        container.appendChild(board);
        return container;
    }

    const columns = ['Scheduled', 'In Progress', 'Completed'];

    columns.forEach(colName => {
        const col = document.createElement('div');
        col.className = 'task-column';

        const header = document.createElement('div');
        header.className = 'column-header';
        header.textContent = colName;
        col.appendChild(header);

        const content = document.createElement('div');
        content.className = 'column-content';

        // Filter tasks
        const colTasks = state.tasks.filter(t => {
            // Status match
            if (mapStatusToColumn(t.status) !== colName) return false;

            // Search query
            if (state.taskSearchQuery) {
                const q = state.taskSearchQuery.toLowerCase();
                if (!t.title.toLowerCase().includes(q) && !t.vtid.toLowerCase().includes(q)) return false;
            }

            // Date filter (assuming createdAt exists and is YYYY-MM-DD compatible or ISO)
            if (state.taskDateFilter && t.createdAt) {
                if (!t.createdAt.startsWith(state.taskDateFilter)) return false;
            }

            return true;
        });

        colTasks.forEach(task => {
            content.appendChild(createTaskCard(task));
        });

        col.appendChild(content);
        board.appendChild(col);
    });

    container.appendChild(board);

    return container;
}

function createTaskCard(task) {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.dataset.status = mapStatusToColumn(task.status).toLowerCase().replace(' ', '-');
    card.onclick = () => {
        state.selectedTask = task;
        state.selectedTaskDetail = null;
        state.selectedTaskDetailLoading = true;
        renderApp();
        // VTID-0527: Fetch full VTID detail with stageTimeline
        fetchVtidDetail(task.vtid);
    };

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = task.title;
    card.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'meta';

    const vtid = document.createElement('span');
    vtid.className = 'vtid';
    vtid.textContent = task.vtid;
    meta.appendChild(vtid);

    const status = document.createElement('span');
    status.textContent = task.status;
    meta.appendChild(status);

    card.appendChild(meta);

    // VTID-0527: Add stage timeline pills
    const stageTimeline = createTaskStageTimeline(task);
    card.appendChild(stageTimeline);

    return card;
}

/**
 * VTID-0527: Create stage timeline pills for a task card.
 * Shows PLANNER → WORKER → VALIDATOR → DEPLOY progression.
 */
function createTaskStageTimeline(task) {
    const timeline = document.createElement('div');
    timeline.className = 'task-stage-timeline';

    // Get stage state from telemetry events
    const stageState = deriveTaskStageState(task, state.telemetryEvents);

    TASK_STAGES.forEach(function(stage) {
        const pill = document.createElement('span');
        const stageInfo = stageState.byStage[stage];
        const isCompleted = stageInfo && stageInfo.reached;
        const isCurrent = stageState.currentStage === stage;

        // Build class list
        const classes = ['task-stage-pill', 'task-stage-pill-' + stage.toLowerCase()];
        if (isCompleted) {
            classes.push('task-stage-pill-completed');
        }
        if (isCurrent) {
            classes.push('task-stage-pill-current');
        }
        if (!isCompleted && !isCurrent) {
            classes.push('task-stage-pill-pending');
        }
        pill.className = classes.join(' ');

        // Use short label
        pill.textContent = STAGE_LABELS[stage];
        pill.title = stage + (isCompleted ? ' (completed)' : isCurrent ? ' (current)' : ' (pending)');

        timeline.appendChild(pill);
    });

    return timeline;
}

function renderTaskDrawer() {
    const drawer = document.createElement('div');
    drawer.className = `task-drawer ${state.selectedTask ? 'open' : ''}`;

    if (!state.selectedTask) return drawer;

    const header = document.createElement('div');
    header.className = 'drawer-header';

    const title = document.createElement('h2');
    title.className = 'drawer-title-text';
    title.textContent = state.selectedTask.vtid;
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'drawer-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => {
        state.selectedTask = null;
        state.selectedTaskDetail = null;
        state.selectedTaskDetailLoading = false;
        renderApp();
    };
    header.appendChild(closeBtn);

    drawer.appendChild(header);

    const content = document.createElement('div');
    content.className = 'drawer-content';

    const summary = document.createElement('p');
    summary.className = 'task-summary-text';
    summary.textContent = state.selectedTask.summary;
    content.appendChild(summary);

    const details = document.createElement('div');
    details.className = 'task-details-block';
    details.innerHTML = `
        <p><strong>Status:</strong> ${state.selectedTask.status}</p>
        <p><strong>Title:</strong> ${state.selectedTask.title}</p>
        <p><strong>Created:</strong> ${state.selectedTask.createdAt || 'N/A'}</p>
    `;
    content.appendChild(details);

    // VTID-0527: Add detailed stage timeline view
    const stageDetail = renderTaskStageDetail(state.selectedTask);
    content.appendChild(stageDetail);

    // DEV-COMHU-0202: Add VTID event history section
    const eventHistory = renderTaskEventHistory(state.selectedTask.vtid);
    content.appendChild(eventHistory);

    drawer.appendChild(content);

    return drawer;
}

/**
 * DEV-COMHU-0202: Get events for a specific VTID from global events state.
 */
function getEventsForVtid(vtid) {
    if (!vtid) return [];
    return (state.events || []).filter(function(e) {
        return e.vtid === vtid;
    });
}

/**
 * DEV-COMHU-0202: Render event history for a VTID in the task drawer.
 * Shows last deploy, governance, and other events for correlation.
 */
function renderTaskEventHistory(vtid) {
    const container = document.createElement('div');
    container.className = 'task-event-history';

    const heading = document.createElement('h3');
    heading.className = 'task-event-history-heading';
    heading.textContent = 'Event History';
    container.appendChild(heading);

    const events = getEventsForVtid(vtid);

    if (!events || events.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'task-event-history-empty';
        emptyDiv.textContent = 'No recent events for this VTID.';
        container.appendChild(emptyDiv);
        return container;
    }

    const list = document.createElement('div');
    list.className = 'task-event-history-list';

    // Show last 5 events, sorted by timestamp (newest first)
    var sortedEvents = events.slice().sort(function(a, b) {
        if (!a.createdAt || !b.createdAt) return 0;
        return new Date(b.createdAt) - new Date(a.createdAt);
    });

    sortedEvents.slice(0, 5).forEach(function(event) {
        const item = document.createElement('div');
        item.className = 'task-event-history-item';

        // Status-based styling
        if (event.topic && event.topic.includes('.success')) {
            item.classList.add('task-event-history-item-success');
        } else if (event.topic && (event.topic.includes('.failed') || event.topic.includes('.blocked'))) {
            item.classList.add('task-event-history-item-error');
        }

        const timestamp = event.createdAt ? new Date(event.createdAt).toLocaleTimeString() : '';

        const timeSpan = document.createElement('span');
        timeSpan.className = 'task-event-history-time';
        timeSpan.textContent = timestamp;
        item.appendChild(timeSpan);

        const topicSpan = document.createElement('span');
        topicSpan.className = 'task-event-history-topic';
        topicSpan.textContent = event.topic || 'unknown';
        item.appendChild(topicSpan);

        if (event.swv) {
            const swvSpan = document.createElement('span');
            swvSpan.className = 'task-event-history-swv';
            swvSpan.textContent = event.swv;
            item.appendChild(swvSpan);
        }

        if (event.message) {
            const msgDiv = document.createElement('div');
            msgDiv.className = 'task-event-history-message';
            msgDiv.textContent = event.message;
            item.appendChild(msgDiv);
        }

        list.appendChild(item);
    });

    container.appendChild(list);
    return container;
}

/**
 * VTID-0527: Render detailed stage timeline for selected task.
 * Shows vertical list of stages with timestamps and messages.
 * Uses API stageTimeline when available, falls back to client-side computation.
 */
function renderTaskStageDetail(task) {
    const container = document.createElement('div');
    container.className = 'task-stage-detail';

    const heading = document.createElement('h3');
    heading.className = 'task-stage-detail-heading';
    heading.textContent = 'Execution Stages';
    container.appendChild(heading);

    // VTID-0527: Show loading state
    if (state.selectedTaskDetailLoading) {
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'task-stage-detail-loading';
        loadingDiv.textContent = 'Loading stage timeline...';
        container.appendChild(loadingDiv);
        return container;
    }

    // VTID-0527: Use API stageTimeline if available, otherwise fall back to client-side
    const apiTimeline = state.selectedTaskDetail && state.selectedTaskDetail.stageTimeline;
    const clientStageState = deriveTaskStageState(task, state.telemetryEvents);

    const list = document.createElement('ul');
    list.className = 'task-stage-detail-list';

    TASK_STAGES.forEach(function(stage) {
        // Get stage info from API timeline or client-side computation
        const apiEntry = apiTimeline ? apiTimeline.find(function(e) { return e.stage === stage; }) : null;
        const clientInfo = clientStageState.byStage[stage];

        // Determine status from API or client
        // VTID-0530: API now returns SUCCESS instead of COMPLETED
        var stageStatus, startedAt, completedAt, errorAt;
        if (apiEntry) {
            stageStatus = apiEntry.status; // 'PENDING', 'RUNNING', 'SUCCESS', 'ERROR' (or legacy 'COMPLETED')
            startedAt = apiEntry.startedAt;
            completedAt = apiEntry.completedAt;
            errorAt = apiEntry.errorAt;
        } else {
            // Fallback to client-side computation
            const isCompleted = clientInfo && clientInfo.reached;
            const isCurrent = clientStageState.currentStage === stage;
            stageStatus = isCompleted ? 'SUCCESS' : isCurrent ? 'RUNNING' : 'PENDING';
            startedAt = clientInfo && clientInfo.latestEvent ? clientInfo.latestEvent.created_at : null;
        }

        const item = document.createElement('li');
        // VTID-0530: Handle both SUCCESS and legacy COMPLETED
        const isSuccess = stageStatus === 'SUCCESS' || stageStatus === 'COMPLETED';
        const statusClass = stageStatus === 'ERROR' ? 'task-stage-detail-item-error' :
                           isSuccess ? 'task-stage-detail-item-completed task-stage-detail-item-success' :
                           stageStatus === 'RUNNING' ? 'task-stage-detail-item-current' :
                           'task-stage-detail-item-pending';
        item.className = 'task-stage-detail-item ' + statusClass;

        // Header row with stage name and status
        const headerRow = document.createElement('div');
        headerRow.className = 'task-stage-detail-header';

        const stageName = document.createElement('span');
        stageName.className = 'task-stage-detail-stage task-stage-detail-stage-' + stage.toLowerCase();
        stageName.textContent = stage;
        headerRow.appendChild(stageName);

        const statusLabel = document.createElement('span');
        statusLabel.className = 'task-stage-detail-status';
        if (stageStatus === 'ERROR') {
            statusLabel.textContent = 'Error';
            statusLabel.classList.add('task-stage-detail-status-error');
        } else if (isSuccess) {
            // VTID-0530: Show "Success" for SUCCESS status (and legacy COMPLETED)
            statusLabel.textContent = 'Success';
            statusLabel.classList.add('task-stage-detail-status-completed');
            statusLabel.classList.add('task-stage-detail-status-success');
        } else if (stageStatus === 'RUNNING') {
            statusLabel.textContent = 'Running';
            statusLabel.classList.add('task-stage-detail-status-current');
        } else {
            statusLabel.textContent = 'Pending';
            statusLabel.classList.add('task-stage-detail-status-pending');
        }
        headerRow.appendChild(statusLabel);

        item.appendChild(headerRow);

        // Meta row with timestamps
        if (startedAt || completedAt || errorAt) {
            const metaRow = document.createElement('div');
            metaRow.className = 'task-stage-detail-meta';

            if (startedAt) {
                const startTime = document.createElement('span');
                startTime.className = 'task-stage-detail-time';
                startTime.textContent = 'Started: ' + formatStageTimestamp(startedAt);
                metaRow.appendChild(startTime);
            }

            if (completedAt) {
                const endTime = document.createElement('span');
                endTime.className = 'task-stage-detail-time task-stage-detail-time-completed';
                endTime.textContent = 'Completed: ' + formatStageTimestamp(completedAt);
                metaRow.appendChild(endTime);
            }

            if (errorAt) {
                const errTime = document.createElement('span');
                errTime.className = 'task-stage-detail-time task-stage-detail-time-error';
                errTime.textContent = 'Error: ' + formatStageTimestamp(errorAt);
                metaRow.appendChild(errTime);
            }

            item.appendChild(metaRow);
        }

        list.appendChild(item);
    });

    container.appendChild(list);

    // VTID-0527: Add vtid-stage-timeline view below the detail list
    const timelineView = renderVtidStageTimeline();
    if (timelineView) {
        container.appendChild(timelineView);
    }

    return container;
}

/**
 * VTID-0527: Render the vtid-stage-timeline visual component.
 * VTID-0530: Updated to handle SUCCESS status.
 * Shows a compact visual timeline with markers and timestamps.
 */
function renderVtidStageTimeline() {
    const apiTimeline = state.selectedTaskDetail && state.selectedTaskDetail.stageTimeline;
    if (!apiTimeline || apiTimeline.length === 0) {
        return null;
    }

    const container = document.createElement('div');
    container.className = 'vtid-stage-timeline';

    apiTimeline.forEach(function(entry) {
        const item = document.createElement('div');
        item.className = 'vtid-stage-timeline-item';

        // Marker
        // VTID-0530: Normalize SUCCESS/COMPLETED to 'success' for CSS class
        var markerStatus = entry.status.toLowerCase();
        if (markerStatus === 'completed') {
            markerStatus = 'success';
        }
        const marker = document.createElement('div');
        marker.className = 'vtid-stage-timeline-item-marker vtid-stage-timeline-item-marker--' + markerStatus;
        item.appendChild(marker);

        // Main content
        const main = document.createElement('div');
        main.className = 'vtid-stage-timeline-item-main';

        const title = document.createElement('div');
        title.className = 'vtid-stage-timeline-item-title';
        title.textContent = entry.stage;
        main.appendChild(title);

        // Timestamp meta
        // VTID-0530: Show "Success" for SUCCESS/COMPLETED status
        var metaText = entry.status;
        var isSuccess = entry.status === 'SUCCESS' || entry.status === 'COMPLETED';
        if (entry.completedAt) {
            metaText = 'Success ' + formatStageTimestamp(entry.completedAt);
        } else if (entry.errorAt) {
            metaText = 'Error ' + formatStageTimestamp(entry.errorAt);
        } else if (entry.startedAt) {
            metaText = (isSuccess ? 'Success' : 'Started') + ' ' + formatStageTimestamp(entry.startedAt);
        } else if (isSuccess) {
            metaText = 'Success';
        }

        const meta = document.createElement('div');
        meta.className = 'vtid-stage-timeline-item-meta';
        meta.textContent = metaText;
        main.appendChild(meta);

        item.appendChild(main);
        container.appendChild(item);
    });

    return container;
}

function renderProfileModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            state.showProfileModal = false;
            renderApp();
        }
    };

    const modal = document.createElement('div');
    modal.className = 'modal';

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.textContent = 'Profile';
    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'modal-body';

    const avatar = document.createElement('div');
    avatar.className = 'profile-avatar-large';
    avatar.textContent = state.user.avatar;
    body.appendChild(avatar);

    const name = document.createElement('div');
    name.className = 'profile-name';
    name.textContent = state.user.name;
    body.appendChild(name);

    const badge = document.createElement('div');
    badge.className = 'profile-role-badge';
    badge.textContent = state.user.role;
    body.appendChild(badge);

    modal.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'modal-footer';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = 'Close';
    closeBtn.onclick = () => {
        state.showProfileModal = false;
        renderApp();
    };
    footer.appendChild(closeBtn);

    modal.appendChild(footer);
    overlay.appendChild(modal);

    return overlay;
}

function renderTaskModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            state.showTaskModal = false;
            renderApp();
        }
    };

    const modal = document.createElement('div');
    modal.className = 'modal';

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.textContent = 'Create New Task';
    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'modal-body';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'form-group';
    titleGroup.innerHTML = '<label>Task Title</label><input type="text" class="form-control" placeholder="Enter title">';
    body.appendChild(titleGroup);

    // VTID-0542: VTID is now auto-generated via allocator, show read-only preview
    const vtidGroup = document.createElement('div');
    vtidGroup.className = 'form-group';
    vtidGroup.innerHTML = '<label>VTID</label><input type="text" class="form-control" placeholder="Auto-generated" readonly disabled style="background:#f5f5f5;color:#666;">';
    body.appendChild(vtidGroup);

    const vtidNote = document.createElement('div');
    vtidNote.className = 'form-note';
    vtidNote.style.cssText = 'font-size:12px;color:#666;margin-top:-8px;margin-bottom:12px;';
    vtidNote.textContent = 'VTID will be auto-allocated when you create the task (VTID-0542)';
    body.appendChild(vtidNote);

    const statusGroup = document.createElement('div');
    statusGroup.className = 'form-group';
    statusGroup.innerHTML = `
        <label>Status</label>
        <select class="form-control">
            <option value="Scheduled">Scheduled</option>
            <option value="In Progress">In Progress</option>
            <option value="Completed">Completed</option>
        </select>
    `;
    body.appendChild(statusGroup);

    modal.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'modal-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => {
        state.showTaskModal = false;
        renderApp();
    };
    footer.appendChild(cancelBtn);

    const createBtn = document.createElement('button');
    createBtn.className = 'btn btn-primary';
    createBtn.textContent = 'Create';
    createBtn.onclick = async () => {
        // Extract form values
        const titleInput = body.querySelector('.form-group:nth-child(1) input');
        const vtidInput = body.querySelector('.form-group:nth-child(2) input');
        const statusSelect = body.querySelector('.form-group:nth-child(4) select'); // Changed to 4th child due to note

        const title = titleInput.value.trim();
        const status = statusSelect.value; // "Scheduled", "In Progress", "Completed"

        // Basic validation
        if (!title) {
            alert('Title is required');
            return;
        }

        // Map UI status to backend status
        let backendStatus = 'pending'; // Default
        if (status === 'In Progress') {
            backendStatus = 'in_progress';
        } else if (status === 'Completed') {
            backendStatus = 'complete';
        } else if (status === 'Scheduled') {
            backendStatus = 'pending';
        }

        try {
            // Disable button to prevent double-submit
            createBtn.disabled = true;
            createBtn.textContent = 'Allocating VTID...';

            // VTID-0542: Step 1 - Call the global allocator to get a VTID
            const allocResponse = await fetch('/api/v1/vtid/allocate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    source: 'command-hub',
                    layer: 'DEV',
                    module: 'COMHU'
                })
            });

            if (!allocResponse.ok) {
                const errorData = await allocResponse.json();
                if (errorData.error === 'allocator_disabled') {
                    alert('VTID Allocator is not active yet. Contact administrator to enable VTID_ALLOCATOR_ENABLED.');
                } else {
                    alert(`Error allocating VTID: ${errorData.message || errorData.error || 'Unknown error'}`);
                }
                createBtn.disabled = false;
                createBtn.textContent = 'Create';
                return;
            }

            const allocResult = await allocResponse.json();
            if (!allocResult.ok || !allocResult.vtid) {
                alert('Failed to allocate VTID. Please try again.');
                createBtn.disabled = false;
                createBtn.textContent = 'Create';
                return;
            }

            const vtid = allocResult.vtid;
            console.log('[VTID-0542] Allocated VTID:', vtid, 'num:', allocResult.num);

            // Update the VTID input to show allocated value
            vtidInput.value = vtid;

            createBtn.textContent = 'Creating task...';

            // VTID-0542: Step 2 - Update the allocated task shell with title/status
            const updatePayload = {
                title: title,
                status: backendStatus
            };

            const updateResponse = await fetch('/api/v1/oasis/tasks/' + encodeURIComponent(vtid), {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(updatePayload)
            });

            if (!updateResponse.ok) {
                // Even if update fails, the task shell exists
                console.warn('[VTID-0542] Task update failed, but VTID allocated:', vtid);
            }

            // Success! Close modal and refresh task list
            state.showTaskModal = false;
            fetchTasks(); // Refresh the task board
            renderApp();

            // Show success message with allocated VTID
            console.log('[VTID-0542] Task created successfully:', vtid);

        } catch (error) {
            console.error('Failed to create task:', error);
            alert(`Failed to create task: ${error.message}`);
            createBtn.disabled = false;
            createBtn.textContent = 'Create';
        }
    };
    footer.appendChild(createBtn);

    modal.appendChild(footer);
    overlay.appendChild(modal);

    return overlay;
}

// --- Logic ---

function handleModuleClick(sectionKey) {
    const section = NAVIGATION_CONFIG.find(s => s.section === sectionKey);
    if (!section) return;

    state.currentModuleKey = sectionKey;
    // Default to first tab
    const firstTab = section.tabs[0];
    state.currentTab = firstTab ? firstTab.key : '';

    // Update URL
    if (firstTab) {
        history.pushState(null, '', firstTab.path);
    } else {
        history.pushState(null, '', section.basePath);
    }

    state.isSplitScreen = false; // Reset split screen on module change
    state.activeSplitScreenId = null;
    // VTID-0406: Close drawers when navigating between modules
    state.selectedTask = null;
    state.selectedTaskDetail = null;
    state.selectedTaskDetailLoading = false;
    state.selectedGovernanceRule = null;
    renderApp();
}

function handleTabClick(tabKey) {
    const section = NAVIGATION_CONFIG.find(s => s.section === state.currentModuleKey);
    if (!section) return;

    const tab = section.tabs.find(t => t.key === tabKey);
    if (!tab) return;

    state.currentTab = tabKey;

    // Update URL
    history.pushState(null, '', tab.path);

    renderApp();
}

// Router Logic

function getRouteFromPath(pathname) {
    // DEV-COMHU-2025-0009: Normalize path - ensure trailing slash for consistent matching
    var normalizedPath = pathname;
    if (normalizedPath && !normalizedPath.endsWith('/')) {
        normalizedPath = normalizedPath + '/';
    }

    // 1. Try to find exact tab match (with normalized path)
    for (const section of NAVIGATION_CONFIG) {
        for (const tab of section.tabs) {
            if (normalizedPath === tab.path) {
                return { section: section.section, tab: tab.key };
            }
        }
    }

    // 2. Try to find section base path match
    for (const section of NAVIGATION_CONFIG) {
        if (normalizedPath === section.basePath) {
            // Default to first tab
            const firstTab = section.tabs[0];
            return { section: section.section, tab: firstTab ? firstTab.key : '' };
        }
    }

    // 3. Fallback
    return { section: 'command-hub', tab: 'tasks' };
}

function formatTabLabel(key) {
    if (!key) return '';
    // DEV-COMHU-2025-0010: Special case handling for VTID labels
    if (key === 'vtid-ledger') return 'VTID Ledger';
    if (key === 'vtids') return 'VTID´s';
    return key.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

window.onpopstate = () => {
    const route = getRouteFromPath(window.location.pathname);
    state.currentModuleKey = route.section;
    state.currentTab = route.tab;
    renderApp();
};

function handleSplitScreenToggle(comboId) {
    if (!comboId) {
        state.isSplitScreen = false;
        state.activeSplitScreenId = null;
        state.leftPane = null;
        state.rightPane = null;
    } else {
        const combo = splitScreenCombos.find(c => c.id === comboId);
        if (combo) {
            state.isSplitScreen = true;
            state.activeSplitScreenId = combo.id;
            state.leftPane = combo.left;
            state.rightPane = combo.right;
        }
    }
    renderApp();
}

function mapStatusToColumn(status) {
    if (!status) return 'Scheduled';
    const s = status.toUpperCase();
    if (['OPEN', 'PENDING', 'SCHEDULED', 'TODO'].includes(s)) return 'Scheduled';
    if (['IN_PROGRESS', 'ACTIVE', 'RUNNING', 'IN PROGRESS'].includes(s)) return 'In Progress';
    if (['COMPLETED', 'DONE', 'CLOSED', 'SUCCESS', 'FAILED'].includes(s)) return 'Completed';
    return 'Scheduled';
}

async function fetchTasks() {
    state.tasksLoading = true;
    renderApp();

    try {
        const response = await fetch('/api/v1/oasis/tasks?limit=50');
        if (!response.ok) throw new Error('Network response was not ok');

        const json = await response.json();
        const data = json.data || json;

        state.tasks = (Array.isArray(data) ? data : []).map(item => ({
            id: item.id,
            title: item.title,
            status: item.status, // Raw status, mapped in UI
            vtid: item.vtid,
            summary: item.summary,
            createdAt: item.created_at || item.createdAt // Capture date for filtering
        }));
        state.tasksError = null;
    } catch (error) {
        console.error('Failed to fetch tasks:', error);
        state.tasksError = error.message;
        // Fallback data for demo if API fails (optional, but good for dev)
        state.tasks = [
            { id: 1, title: 'Fallback Task 1', status: 'Scheduled', vtid: 'VTID-001', summary: 'Fallback data due to API error.', createdAt: '2023-10-27' }
        ];
    } finally {
        state.tasksLoading = false;
        renderApp();
    }
}

/**
 * VTID-0527: Fetch VTID detail with stageTimeline from API.
 * Called when a task card is clicked to load detailed stage timeline.
 */
async function fetchVtidDetail(vtid) {
    console.log('[VTID-0527] Fetching VTID detail:', vtid);
    state.selectedTaskDetailLoading = true;

    try {
        const response = await fetch('/api/v1/vtid/' + encodeURIComponent(vtid));
        if (!response.ok) {
            throw new Error('VTID detail fetch failed: ' + response.status);
        }

        const result = await response.json();
        console.log('[VTID-0527] VTID detail loaded:', result);

        if (result.ok && result.data) {
            state.selectedTaskDetail = result.data;
        }
    } catch (error) {
        console.error('[VTID-0527] Failed to fetch VTID detail:', error);
        // Continue without detail - not critical, fallback to client-side computation
    } finally {
        state.selectedTaskDetailLoading = false;
        renderApp();
    }
}

async function fetchScreenInventory() {
    state.screenInventoryLoading = true;
    renderApp();

    try {
        const response = await fetch('/api/v1/oasis/specs/dev-screen-inventory');
        if (!response.ok) throw new Error('Network response was not ok');

        const json = await response.json();
        if (json.ok && json.data) {
            state.screenInventory = json.data;
            state.screenInventoryError = null;
        } else {
            throw new Error(json.error || 'Failed to load screen inventory');
        }
    } catch (error) {
        console.error('Failed to fetch screen inventory:', error);
        state.screenInventoryError = error.message;
        state.screenInventory = null;
    } finally {
        state.screenInventoryLoading = false;
        renderApp();
    }
}

// --- Governance Rules (VTID-0401) ---

/**
 * VTID-0401: Fetches governance rules from the catalog API endpoint.
 * Populates state.governanceRules with the catalog data.
 */
async function fetchGovernanceRules() {
    state.governanceRulesLoading = true;
    renderApp();

    try {
        const response = await fetch('/api/v1/governance/rules');
        if (!response.ok) throw new Error('Network response was not ok: ' + response.status);

        const json = await response.json();
        if (json.ok && json.data) {
            state.governanceRules = json.data;
            state.governanceRulesError = null;
            console.log('[VTID-0401] Governance rules loaded:', json.count, 'rules');
        } else {
            throw new Error(json.error || 'Failed to load governance rules');
        }
    } catch (error) {
        console.error('[VTID-0401] Failed to fetch governance rules:', error);
        state.governanceRulesError = error.message;
        state.governanceRules = [];
    } finally {
        state.governanceRulesLoading = false;
        renderApp();
    }
}

/**
 * VTID-0401: Sorts governance rules by the specified column.
 */
function sortGovernanceRules(column) {
    if (state.governanceRulesSortColumn === column) {
        // Toggle direction
        state.governanceRulesSortDirection = state.governanceRulesSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        state.governanceRulesSortColumn = column;
        state.governanceRulesSortDirection = 'asc';
    }
    renderApp();
}

/**
 * VTID-0401: Returns sorted and filtered governance rules.
 */
function getFilteredGovernanceRules() {
    let rules = [...state.governanceRules];

    // Apply search filter (VTID-0405: extended to include description)
    if (state.governanceRulesSearchQuery) {
        const query = state.governanceRulesSearchQuery.toLowerCase();
        rules = rules.filter(r =>
            r.id.toLowerCase().includes(query) ||
            r.title.toLowerCase().includes(query) ||
            (r.description && r.description.toLowerCase().includes(query))
        );
    }

    // Apply level filter
    if (state.governanceRulesLevelFilter) {
        rules = rules.filter(r => r.level === state.governanceRulesLevelFilter);
    }

    // Apply category filter
    if (state.governanceRulesCategoryFilter) {
        rules = rules.filter(r => r.domain === state.governanceRulesCategoryFilter);
    }

    // VTID-0405: Apply source filter (SYSTEM/CATALOG)
    if (state.governanceRulesSourceFilter) {
        rules = rules.filter(r => r.source === state.governanceRulesSourceFilter);
    }

    // Apply sorting
    const col = state.governanceRulesSortColumn;
    const dir = state.governanceRulesSortDirection === 'asc' ? 1 : -1;

    rules.sort((a, b) => {
        let aVal = a[col] || '';
        let bVal = b[col] || '';
        if (typeof aVal === 'string') aVal = aVal.toLowerCase();
        if (typeof bVal === 'string') bVal = bVal.toLowerCase();
        if (aVal < bVal) return -1 * dir;
        if (aVal > bVal) return 1 * dir;
        return 0;
    });

    return rules;
}

/**
 * VTID-0401: Renders the Governance Rules catalog view.
 */
function renderGovernanceRulesView() {
    const container = document.createElement('div');
    container.className = 'governance-rules-container';

    // Auto-fetch governance rules if not loaded and not currently loading
    if (state.governanceRules.length === 0 && !state.governanceRulesLoading && !state.governanceRulesError) {
        fetchGovernanceRules();
    }

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'governance-rules-toolbar';

    // Search input
    const search = document.createElement('input');
    search.className = 'search-field governance-rules-search';
    search.placeholder = 'Search rules by ID or title...';
    search.value = state.governanceRulesSearchQuery;
    search.oninput = (e) => {
        state.governanceRulesSearchQuery = e.target.value;
        renderApp();
    };
    toolbar.appendChild(search);

    // Level filter - static options per VTID-0401-B spec
    const levelSelect = document.createElement('select');
    levelSelect.className = 'form-control governance-filter-select';
    levelSelect.setAttribute('autocomplete', 'off');
    levelSelect.setAttribute('data-lpignore', 'true'); // LastPass ignore
    levelSelect.name = 'governance-level-filter-' + Date.now(); // Unique name prevents autofill
    levelSelect.innerHTML = '<option value="">All Levels</option>' +
        '<option value="L1">L1 (Critical)</option>' +
        '<option value="L2">L2 (Standard)</option>' +
        '<option value="L3">L3 (Structural)</option>' +
        '<option value="L4">L4 (Autonomy / Agents)</option>';
    // Set value based on state - empty string means "All Levels"
    levelSelect.value = state.governanceRulesLevelFilter || '';
    levelSelect.onchange = (e) => {
        state.governanceRulesLevelFilter = e.target.value;
        renderApp();
    };
    toolbar.appendChild(levelSelect);

    // Category/Domain filter - static options per VTID-0401-B spec
    // Using 6 canonical categories from specs/governance/rules.json
    const categorySelect = document.createElement('select');
    categorySelect.className = 'form-control governance-filter-select';
    categorySelect.setAttribute('autocomplete', 'off');
    categorySelect.setAttribute('data-lpignore', 'true'); // LastPass ignore
    categorySelect.name = 'governance-category-filter-' + Date.now(); // Unique name prevents autofill
    categorySelect.innerHTML = '<option value="">All Categories</option>' +
        '<option value="MIGRATION">Migration Governance</option>' +
        '<option value="FRONTEND">Frontend Governance</option>' +
        '<option value="CICD">CI/CD Governance</option>' +
        '<option value="DB">Database Governance</option>' +
        '<option value="AGENT">Agent Governance</option>' +
        '<option value="API">API Governance</option>';
    // Set value based on state - empty string means "All Categories"
    categorySelect.value = state.governanceRulesCategoryFilter || '';
    categorySelect.onchange = (e) => {
        state.governanceRulesCategoryFilter = e.target.value;
        renderApp();
    };
    toolbar.appendChild(categorySelect);

    // VTID-0405: Source/Family filter (SYSTEM vs CATALOG)
    const sourceSelect = document.createElement('select');
    sourceSelect.className = 'form-control governance-filter-select';
    sourceSelect.setAttribute('autocomplete', 'off');
    sourceSelect.setAttribute('data-lpignore', 'true');
    sourceSelect.name = 'governance-source-filter-' + Date.now();
    sourceSelect.innerHTML = '<option value="">All Sources</option>' +
        '<option value="SYSTEM">System Rules</option>' +
        '<option value="CATALOG">Catalog Rules</option>';
    sourceSelect.value = state.governanceRulesSourceFilter || '';
    sourceSelect.onchange = (e) => {
        state.governanceRulesSourceFilter = e.target.value;
        renderApp();
    };
    toolbar.appendChild(sourceSelect);

    // Spacer
    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    toolbar.appendChild(spacer);

    // Rule count
    const filteredRules = getFilteredGovernanceRules();
    const countLabel = document.createElement('span');
    countLabel.className = 'governance-rules-count';
    countLabel.textContent = filteredRules.length + ' of ' + state.governanceRules.length + ' rules';
    toolbar.appendChild(countLabel);

    // Refresh button
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn';
    refreshBtn.textContent = '↻';
    refreshBtn.title = 'Refresh rules';
    refreshBtn.onclick = () => { fetchGovernanceRules(); };
    toolbar.appendChild(refreshBtn);

    container.appendChild(toolbar);

    // Loading state
    if (state.governanceRulesLoading) {
        const loading = document.createElement('div');
        loading.className = 'governance-rules-loading';
        loading.innerHTML = '<div class="skeleton-table">' +
            '<div class="skeleton-row"></div>'.repeat(10) +
            '</div>';
        container.appendChild(loading);
        return container;
    }

    // Error state
    if (state.governanceRulesError) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'governance-rules-error';
        errorDiv.innerHTML = '<span class="error-icon">⚠</span> Error loading rules: ' + state.governanceRulesError;
        container.appendChild(errorDiv);
        return container;
    }

    // Table
    const tableWrapper = document.createElement('div');
    tableWrapper.className = 'governance-rules-table-wrapper';

    const table = document.createElement('table');
    table.className = 'governance-rules-table';

    // Table header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    const columns = [
        { key: 'id', label: 'Rule ID', sortable: true },
        { key: 'level', label: 'Level', sortable: true },
        { key: 'domain', label: 'Domain', sortable: true },
        { key: 'title', label: 'Title', sortable: true },
        { key: 'status', label: 'Status', sortable: true },
        { key: 'vtids', label: 'VTIDs', sortable: false },
        { key: 'updated_at', label: 'Updated', sortable: true }
    ];

    columns.forEach(col => {
        const th = document.createElement('th');
        th.className = col.sortable ? 'sortable' : '';
        if (col.sortable) {
            th.onclick = () => sortGovernanceRules(col.key);
            const sortIndicator = state.governanceRulesSortColumn === col.key
                ? (state.governanceRulesSortDirection === 'asc' ? ' ↑' : ' ↓')
                : '';
            th.textContent = col.label + sortIndicator;
        } else {
            th.textContent = col.label;
        }
        headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body
    const tbody = document.createElement('tbody');

    filteredRules.forEach(rule => {
        const row = document.createElement('tr');
        row.className = 'governance-rule-row';
        row.onclick = () => {
            state.selectedGovernanceRule = rule;
            renderApp();
        };

        // Rule ID
        const idCell = document.createElement('td');
        idCell.className = 'rule-id-cell';
        idCell.textContent = rule.id;
        row.appendChild(idCell);

        // Level with badge
        const levelCell = document.createElement('td');
        const levelBadge = document.createElement('span');
        levelBadge.className = 'level-badge level-' + rule.level.toLowerCase();
        levelBadge.textContent = rule.level;
        levelCell.appendChild(levelBadge);
        row.appendChild(levelCell);

        // Domain
        const domainCell = document.createElement('td');
        domainCell.className = 'domain-cell';
        domainCell.textContent = rule.domain;
        row.appendChild(domainCell);

        // Title
        const titleCell = document.createElement('td');
        titleCell.className = 'title-cell';
        titleCell.textContent = rule.title;
        row.appendChild(titleCell);

        // Status with badge
        const statusCell = document.createElement('td');
        const statusBadge = document.createElement('span');
        statusBadge.className = 'status-badge status-' + rule.status.toLowerCase();
        statusBadge.textContent = rule.status.charAt(0).toUpperCase() + rule.status.slice(1);
        statusCell.appendChild(statusBadge);
        row.appendChild(statusCell);

        // VTIDs
        const vtidsCell = document.createElement('td');
        vtidsCell.className = 'vtids-cell';
        if (rule.vtids && rule.vtids.length > 0) {
            vtidsCell.innerHTML = rule.vtids.slice(0, 2).map(v =>
                '<span class="vtid-chip">' + v + '</span>'
            ).join('');
            if (rule.vtids.length > 2) {
                vtidsCell.innerHTML += '<span class="vtid-more">+' + (rule.vtids.length - 2) + '</span>';
            }
        } else {
            vtidsCell.textContent = '-';
        }
        row.appendChild(vtidsCell);

        // Updated
        const updatedCell = document.createElement('td');
        updatedCell.className = 'updated-cell';
        updatedCell.textContent = formatRelativeDate(rule.updated_at);
        row.appendChild(updatedCell);

        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    tableWrapper.appendChild(table);
    container.appendChild(tableWrapper);

    return container;
}

/**
 * VTID-0401: Renders the rule detail sheet/drawer.
 */
function renderGovernanceRuleDetailDrawer() {
    const drawer = document.createElement('div');
    drawer.className = 'governance-rule-drawer ' + (state.selectedGovernanceRule ? 'open' : '');

    if (!state.selectedGovernanceRule) return drawer;

    const rule = state.selectedGovernanceRule;

    // Header
    const header = document.createElement('div');
    header.className = 'drawer-header';

    const title = document.createElement('h2');
    title.className = 'drawer-title-text';
    title.textContent = rule.id;
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'drawer-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => {
        state.selectedGovernanceRule = null;
        renderApp();
    };
    header.appendChild(closeBtn);

    drawer.appendChild(header);

    // Content
    const content = document.createElement('div');
    content.className = 'drawer-content';

    // Rule metadata
    const metaSection = document.createElement('div');
    metaSection.className = 'rule-detail-meta';

    const levelBadge = document.createElement('span');
    levelBadge.className = 'level-badge level-' + rule.level.toLowerCase();
    levelBadge.textContent = rule.level;
    metaSection.appendChild(levelBadge);

    const statusBadge = document.createElement('span');
    statusBadge.className = 'status-badge status-' + rule.status.toLowerCase();
    statusBadge.textContent = rule.status.charAt(0).toUpperCase() + rule.status.slice(1);
    metaSection.appendChild(statusBadge);

    const domainBadge = document.createElement('span');
    domainBadge.className = 'domain-badge';
    domainBadge.textContent = rule.domain;
    metaSection.appendChild(domainBadge);

    content.appendChild(metaSection);

    // Title
    const titleSection = document.createElement('div');
    titleSection.className = 'rule-detail-section';
    titleSection.innerHTML = '<h3>Title</h3><p>' + escapeHtml(rule.title) + '</p>';
    content.appendChild(titleSection);

    // Description
    const descSection = document.createElement('div');
    descSection.className = 'rule-detail-section';
    descSection.innerHTML = '<h3>Description</h3><p>' + escapeHtml(rule.description) + '</p>';
    content.appendChild(descSection);

    // Category
    const categorySection = document.createElement('div');
    categorySection.className = 'rule-detail-section';
    categorySection.innerHTML = '<h3>Category</h3><p>' + escapeHtml(rule.category) + '</p>';
    content.appendChild(categorySection);

    // VTID-0405: Source/Family (SYSTEM vs CATALOG)
    const sourceSection = document.createElement('div');
    sourceSection.className = 'rule-detail-section';
    const sourceValue = rule.source || 'CATALOG';
    const sourceLabel = sourceValue === 'SYSTEM' ? 'System Rule' : 'Catalog Rule';
    sourceSection.innerHTML = '<h3>Source</h3><p><span class="source-badge source-' + sourceValue.toLowerCase() + '">' + sourceLabel + '</span></p>';
    content.appendChild(sourceSection);

    // VTID-0405: Enforcement Semantics based on level
    const enforcementSemanticsSection = document.createElement('div');
    enforcementSemanticsSection.className = 'rule-detail-section';
    let enforcementSemantics = '';
    let enforcementClass = '';
    switch (rule.level) {
        case 'L1':
            enforcementSemantics = 'Hard block — always denies. This rule cannot be bypassed and will block any violating action.';
            enforcementClass = 'enforcement-hard';
            break;
        case 'L2':
            enforcementSemantics = 'Soft block — denies unless override (future). This rule blocks by default but may support authorized overrides.';
            enforcementClass = 'enforcement-soft';
            break;
        case 'L3':
            enforcementSemantics = 'Informational — not blocking. This rule logs violations but does not prevent actions.';
            enforcementClass = 'enforcement-info';
            break;
        case 'L4':
            enforcementSemantics = 'Informational — not blocking. Advisory rule for agent autonomy guidance.';
            enforcementClass = 'enforcement-info';
            break;
        default:
            enforcementSemantics = 'Unknown enforcement level.';
            enforcementClass = 'enforcement-info';
    }
    enforcementSemanticsSection.innerHTML = '<h3>Enforcement Semantics</h3><div class="enforcement-semantics ' + enforcementClass + '">' + enforcementSemantics + '</div>';
    content.appendChild(enforcementSemanticsSection);

    // VTIDs
    if (rule.vtids && rule.vtids.length > 0) {
        const vtidsSection = document.createElement('div');
        vtidsSection.className = 'rule-detail-section';
        vtidsSection.innerHTML = '<h3>Linked VTIDs</h3><div class="vtid-chips">' +
            rule.vtids.map(v => '<span class="vtid-chip">' + escapeHtml(v) + '</span>').join('') +
            '</div>';
        content.appendChild(vtidsSection);
    }

    // Sources
    if (rule.sources && rule.sources.length > 0) {
        const sourcesSection = document.createElement('div');
        sourcesSection.className = 'rule-detail-section';
        sourcesSection.innerHTML = '<h3>Sources</h3><ul class="sources-list">' +
            rule.sources.map(s => '<li><code>' + escapeHtml(s) + '</code></li>').join('') +
            '</ul>';
        content.appendChild(sourcesSection);
    }

    // Enforcement
    if (rule.enforcement && rule.enforcement.length > 0) {
        const enforcementSection = document.createElement('div');
        enforcementSection.className = 'rule-detail-section';
        enforcementSection.innerHTML = '<h3>Enforcement</h3><div class="enforcement-chips">' +
            rule.enforcement.map(e => '<span class="enforcement-chip">' + escapeHtml(e) + '</span>').join('') +
            '</div>';
        content.appendChild(enforcementSection);
    }

    // VTID-0405: Created At
    const createdSection = document.createElement('div');
    createdSection.className = 'rule-detail-section';
    createdSection.innerHTML = '<h3>Created</h3><p>' + formatRelativeDate(rule.created_at) + '</p>';
    content.appendChild(createdSection);

    // Updated
    const updatedSection = document.createElement('div');
    updatedSection.className = 'rule-detail-section';
    updatedSection.innerHTML = '<h3>Last Updated</h3><p>' + formatRelativeDate(rule.updated_at) + '</p>';
    content.appendChild(updatedSection);

    drawer.appendChild(content);

    return drawer;
}

/**
 * Helper: Format relative date.
 */
function formatRelativeDate(dateStr) {
    if (!dateStr) return '-';
    try {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return diffDays + ' days ago';
        if (diffDays < 30) return Math.floor(diffDays / 7) + ' weeks ago';
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
        return dateStr;
    }
}

/**
 * Helper: Escape HTML to prevent XSS.
 */
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// --- VTID-0406: Governance Evaluations Viewer (OASIS Integration) ---

/**
 * VTID-0406: Fetches governance evaluation events from OASIS.
 * Populates state.governanceEvaluations with the evaluation data.
 */
async function fetchGovernanceEvaluations() {
    state.governanceEvaluationsLoading = true;
    state.governanceEvaluationsFetched = true;
    renderApp();

    try {
        const response = await fetch('/api/v1/governance/evaluations');
        const json = await response.json();

        if (json.ok && json.data) {
            state.governanceEvaluations = json.data;
            state.governanceEvaluationsError = null;
            console.log('[VTID-0406] Governance evaluations loaded:', json.count, 'evaluations');
        } else {
            throw new Error(json.error || 'Failed to load governance evaluations');
        }
    } catch (error) {
        console.error('[VTID-0406] Failed to fetch governance evaluations:', error);
        state.governanceEvaluationsError = error.message;
        state.governanceEvaluations = [];
    }
    state.governanceEvaluationsLoading = false;
    renderApp();
}

/**
 * VTID-0406: Returns filtered governance evaluations based on result filter.
 */
function getFilteredGovernanceEvaluations() {
    var evals = state.governanceEvaluations.slice();

    // Filter by result (allow/deny)
    if (state.governanceEvaluationsResultFilter) {
        var isAllow = state.governanceEvaluationsResultFilter === 'allow';
        evals = evals.filter(function(ev) { return ev.allow === isAllow; });
    }

    return evals;
}

/**
 * VTID-0406: Renders the Governance Evaluations viewer.
 */
function renderGovernanceEvaluationsView() {
    var container = document.createElement('div');
    container.className = 'gov-evals-container';

    // Auto-fetch evaluations if not yet fetched and not currently loading
    if (!state.governanceEvaluationsFetched && !state.governanceEvaluationsLoading) {
        fetchGovernanceEvaluations();
    }

    // Toolbar
    var toolbar = document.createElement('div');
    toolbar.className = 'gov-evals-toolbar';

    // Result filter
    var resultSelect = document.createElement('select');
    resultSelect.className = 'form-control governance-filter-select';
    resultSelect.autocomplete = 'off';
    resultSelect.name = 'gov-evals-result-filter-' + Date.now();
    resultSelect.innerHTML =
        '<option value="">All Results</option>' +
        '<option value="allow">Allow</option>' +
        '<option value="deny">Deny</option>';
    resultSelect.value = state.governanceEvaluationsResultFilter || '';
    resultSelect.onchange = function(e) {
        state.governanceEvaluationsResultFilter = e.target.value;
        renderApp();
    };
    toolbar.appendChild(resultSelect);

    // Spacer
    var spacer = document.createElement('div');
    spacer.className = 'spacer';
    toolbar.appendChild(spacer);

    // Count label
    var filteredEvals = getFilteredGovernanceEvaluations();
    var countLabel = document.createElement('span');
    countLabel.className = 'gov-evals-count';
    countLabel.textContent = filteredEvals.length + ' of ' + state.governanceEvaluations.length + ' evaluations';
    toolbar.appendChild(countLabel);

    // Refresh button
    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn';
    refreshBtn.textContent = '↻';
    refreshBtn.onclick = function() { fetchGovernanceEvaluations(); };
    toolbar.appendChild(refreshBtn);

    container.appendChild(toolbar);

    // Loading state
    if (state.governanceEvaluationsLoading) {
        var loading = document.createElement('div');
        loading.className = 'gov-evals-loading';
        loading.innerHTML = '<div class="skeleton-table">' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '</div>';
        container.appendChild(loading);
        return container;
    }

    // Error state
    if (state.governanceEvaluationsError) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'gov-evals-error';
        errorDiv.innerHTML = '<span class="error-icon">⚠</span> Error loading evaluations: ' + state.governanceEvaluationsError;
        container.appendChild(errorDiv);
        return container;
    }

    // Empty state
    if (filteredEvals.length === 0) {
        var emptyDiv = document.createElement('div');
        emptyDiv.className = 'gov-evals-empty';
        emptyDiv.innerHTML = '<p>No governance evaluations found.</p>' +
            '<p class="gov-evals-empty-hint">Evaluations will appear here when the GovernanceEvaluator processes requests.</p>';
        container.appendChild(emptyDiv);
        return container;
    }

    // Table wrapper
    var tableWrapper = document.createElement('div');
    tableWrapper.className = 'gov-evals-table-wrapper';

    // Table
    var table = document.createElement('table');
    table.className = 'gov-evals-table';

    // Table header
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    var headers = ['Timestamp', 'Action', 'Service', 'Env', 'Result', 'Violated Rules'];
    headers.forEach(function(headerText) {
        var th = document.createElement('th');
        th.textContent = headerText;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body
    var tbody = document.createElement('tbody');
    filteredEvals.forEach(function(evalItem) {
        var row = document.createElement('tr');
        row.className = 'gov-eval-row';

        // Timestamp
        var timestampTd = document.createElement('td');
        timestampTd.className = 'gov-eval-timestamp';
        timestampTd.textContent = formatEvalTimestamp(evalItem.created_at);
        row.appendChild(timestampTd);

        // Action
        var actionTd = document.createElement('td');
        actionTd.className = 'gov-eval-action';
        actionTd.textContent = evalItem.action;
        row.appendChild(actionTd);

        // Service
        var serviceTd = document.createElement('td');
        serviceTd.className = 'gov-eval-service';
        serviceTd.textContent = evalItem.service;
        row.appendChild(serviceTd);

        // Environment
        var envTd = document.createElement('td');
        envTd.className = 'gov-eval-env';
        envTd.textContent = evalItem.environment;
        row.appendChild(envTd);

        // Result (Allow/Deny)
        var resultTd = document.createElement('td');
        var resultBadge = document.createElement('span');
        resultBadge.className = evalItem.allow ? 'gov-eval-allow' : 'gov-eval-deny';
        resultBadge.textContent = evalItem.allow ? 'Allow' : 'Deny';
        resultTd.appendChild(resultBadge);
        row.appendChild(resultTd);

        // Violated Rules (chips)
        var rulesTd = document.createElement('td');
        rulesTd.className = 'gov-eval-rules';
        if (evalItem.violated_rules && evalItem.violated_rules.length > 0) {
            evalItem.violated_rules.forEach(function(rule) {
                var chip = document.createElement('span');
                chip.className = 'gov-rule-chip gov-rule-chip-' + rule.level.toLowerCase();
                chip.innerHTML = '<span class="gov-rule-chip-id">' + escapeHtml(rule.rule_id) + '</span>' +
                    '<span class="gov-rule-chip-level">' + rule.level + '</span>';
                chip.title = rule.domain + ' - ' + rule.level;
                // VTID-0406: Click chip to open Rule Detail Drawer from VTID-0405
                chip.onclick = function(e) {
                    e.stopPropagation();
                    openRuleDetailByCode(rule.rule_id);
                };
                rulesTd.appendChild(chip);
            });
        } else {
            rulesTd.innerHTML = '<span class="gov-eval-no-violations">—</span>';
        }
        row.appendChild(rulesTd);

        tbody.appendChild(row);
    });
    table.appendChild(tbody);
    tableWrapper.appendChild(table);
    container.appendChild(tableWrapper);

    return container;
}

/**
 * VTID-0406: Format timestamp for evaluation display.
 */
function formatEvalTimestamp(dateStr) {
    if (!dateStr) return '-';
    try {
        var date = new Date(dateStr);
        return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    } catch (e) {
        return dateStr;
    }
}

/**
 * VTID-0406: Opens the Rule Detail Drawer for a specific rule code.
 * Links to VTID-0405 Rule Detail Drawer functionality.
 */
function openRuleDetailByCode(ruleCode) {
    // Find the rule in the loaded governance rules
    var rule = state.governanceRules.find(function(r) {
        return r.id === ruleCode;
    });

    if (rule) {
        state.selectedGovernanceRule = rule;
        renderApp();
    } else {
        // If rules aren't loaded, fetch them first then try again
        console.log('[VTID-0406] Rule not in cache, fetching rules first:', ruleCode);
        fetchGovernanceRules().then(function() {
            var foundRule = state.governanceRules.find(function(r) {
                return r.id === ruleCode;
            });
            if (foundRule) {
                state.selectedGovernanceRule = foundRule;
                renderApp();
            } else {
                console.warn('[VTID-0406] Rule not found:', ruleCode);
            }
        });
    }
}

// --- VTID-0408: Governance History Timeline ---

/**
 * VTID-0408: Fetches governance history events from OASIS.
 * Populates state.governanceHistory with the event data.
 */
async function fetchGovernanceHistory() {
    state.governanceHistory.loading = true;
    state.governanceHistory.fetched = true;
    renderApp();

    try {
        // Build query string from filters and pagination
        var params = new URLSearchParams();
        params.append('limit', state.governanceHistory.pagination.limit.toString());
        params.append('offset', state.governanceHistory.pagination.offset.toString());

        if (state.governanceHistory.filters.type !== 'all') {
            params.append('type', state.governanceHistory.filters.type);
        }
        if (state.governanceHistory.filters.level !== 'all') {
            params.append('level', state.governanceHistory.filters.level);
        }
        if (state.governanceHistory.filters.actor !== 'all') {
            params.append('actor', state.governanceHistory.filters.actor);
        }

        var response = await fetch('/api/v1/governance/history?' + params.toString());
        var json = await response.json();

        if (json.ok && json.events) {
            state.governanceHistory.items = json.events;
            state.governanceHistory.pagination.hasMore = json.pagination.has_more;
            state.governanceHistory.error = null;
            console.log('[VTID-0408] Governance history loaded:', json.events.length, 'events');
        } else {
            throw new Error(json.error || 'Failed to load governance history');
        }
    } catch (error) {
        console.warn('[VTID-0408] Governance history fetch error:', error);
        state.governanceHistory.error = error.message;
        state.governanceHistory.items = [];
    }
    state.governanceHistory.loading = false;
    renderApp();
}

/**
 * VTID-0408: Renders the Governance History viewer.
 */
function renderGovernanceHistoryView() {
    var container = document.createElement('div');
    container.className = 'gov-history-container';

    // Auto-fetch history if not yet fetched and not currently loading
    if (!state.governanceHistory.fetched && !state.governanceHistory.loading) {
        fetchGovernanceHistory();
    }

    // Toolbar with filters
    var toolbar = document.createElement('div');
    toolbar.className = 'gov-history-toolbar';

    // Event Type filter
    var typeSelect = document.createElement('select');
    typeSelect.className = 'form-control governance-filter-select';
    typeSelect.autocomplete = 'off';
    typeSelect.name = 'gov-history-type-filter-' + Date.now();
    typeSelect.innerHTML =
        '<option value="all">All Types</option>' +
        '<option value="governance.deploy.allowed">Deploy Allowed</option>' +
        '<option value="governance.deploy.blocked">Deploy Blocked</option>' +
        '<option value="governance.evaluate">Evaluate</option>' +
        '<option value="governance.rule.created">Rule Created</option>' +
        '<option value="governance.rule.updated">Rule Updated</option>';
    typeSelect.value = state.governanceHistory.filters.type;
    typeSelect.onchange = function(e) {
        state.governanceHistory.filters.type = e.target.value;
        state.governanceHistory.pagination.offset = 0;
        state.governanceHistory.fetched = false;
        fetchGovernanceHistory();
    };
    toolbar.appendChild(typeSelect);

    // Level filter
    var levelSelect = document.createElement('select');
    levelSelect.className = 'form-control governance-filter-select';
    levelSelect.autocomplete = 'off';
    levelSelect.name = 'gov-history-level-filter-' + Date.now();
    levelSelect.innerHTML =
        '<option value="all">All Levels</option>' +
        '<option value="L1">L1</option>' +
        '<option value="L2">L2</option>' +
        '<option value="L3">L3</option>' +
        '<option value="L4">L4</option>';
    levelSelect.value = state.governanceHistory.filters.level;
    levelSelect.onchange = function(e) {
        state.governanceHistory.filters.level = e.target.value;
        state.governanceHistory.pagination.offset = 0;
        state.governanceHistory.fetched = false;
        fetchGovernanceHistory();
    };
    toolbar.appendChild(levelSelect);

    // Actor filter
    var actorSelect = document.createElement('select');
    actorSelect.className = 'form-control governance-filter-select';
    actorSelect.autocomplete = 'off';
    actorSelect.name = 'gov-history-actor-filter-' + Date.now();
    actorSelect.innerHTML =
        '<option value="all">All Actors</option>' +
        '<option value="operator">Operator</option>' +
        '<option value="autopilot">Autopilot</option>' +
        '<option value="validator">Validator</option>' +
        '<option value="system">System</option>';
    actorSelect.value = state.governanceHistory.filters.actor;
    actorSelect.onchange = function(e) {
        state.governanceHistory.filters.actor = e.target.value;
        state.governanceHistory.pagination.offset = 0;
        state.governanceHistory.fetched = false;
        fetchGovernanceHistory();
    };
    toolbar.appendChild(actorSelect);

    // Spacer
    var spacer = document.createElement('div');
    spacer.className = 'spacer';
    toolbar.appendChild(spacer);

    // Count label
    var countLabel = document.createElement('span');
    countLabel.className = 'gov-history-count';
    countLabel.textContent = state.governanceHistory.items.length + ' events';
    toolbar.appendChild(countLabel);

    // Refresh button
    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn';
    refreshBtn.textContent = '↻';
    refreshBtn.title = 'Refresh';
    refreshBtn.onclick = function() {
        state.governanceHistory.fetched = false;
        fetchGovernanceHistory();
    };
    toolbar.appendChild(refreshBtn);

    container.appendChild(toolbar);

    // Loading state
    if (state.governanceHistory.loading) {
        var loading = document.createElement('div');
        loading.className = 'gov-history-loading';
        loading.innerHTML = '<div class="skeleton-table">' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '</div>';
        container.appendChild(loading);
        return container;
    }

    // Error state
    if (state.governanceHistory.error) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'gov-history-error';
        errorDiv.innerHTML = '<span class="error-icon">⚠</span> Error loading history: ' + escapeHtml(state.governanceHistory.error);
        container.appendChild(errorDiv);
        return container;
    }

    // Empty state
    if (state.governanceHistory.items.length === 0) {
        var emptyDiv = document.createElement('div');
        emptyDiv.className = 'gov-history-empty';
        emptyDiv.innerHTML = '<p>No governance history events found.</p>' +
            '<p class="gov-history-empty-hint">Events will appear here as governance actions are performed.</p>';
        container.appendChild(emptyDiv);
        return container;
    }

    // Table wrapper
    var tableWrapper = document.createElement('div');
    tableWrapper.className = 'gov-history-table-wrapper';

    // Table
    var table = document.createElement('table');
    table.className = 'gov-history-table';

    // Table header
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    var headers = ['Timestamp', 'Type', 'Level', 'Actor', 'Summary', ''];
    headers.forEach(function(headerText) {
        var th = document.createElement('th');
        th.textContent = headerText;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body
    var tbody = document.createElement('tbody');
    state.governanceHistory.items.forEach(function(event) {
        var row = document.createElement('tr');
        row.className = 'gov-history-row';
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', 'View event details: ' + event.summary);

        // Timestamp
        var timestampTd = document.createElement('td');
        timestampTd.className = 'gov-history-timestamp';
        timestampTd.textContent = formatHistoryTimestamp(event.timestamp);
        row.appendChild(timestampTd);

        // Type (badge)
        var typeTd = document.createElement('td');
        var typeBadge = document.createElement('span');
        typeBadge.className = 'gov-history-type-badge ' + getHistoryTypeBadgeClass(event.type);
        typeBadge.textContent = formatHistoryType(event.type);
        typeTd.appendChild(typeBadge);
        row.appendChild(typeTd);

        // Level
        var levelTd = document.createElement('td');
        if (event.level) {
            var levelBadge = document.createElement('span');
            levelBadge.className = 'level-badge level-' + event.level.toLowerCase();
            levelBadge.textContent = event.level;
            levelTd.appendChild(levelBadge);
        } else {
            levelTd.innerHTML = '<span class="gov-history-no-level">—</span>';
        }
        row.appendChild(levelTd);

        // Actor
        var actorTd = document.createElement('td');
        actorTd.className = 'gov-history-actor';
        var actorBadge = document.createElement('span');
        actorBadge.className = 'gov-history-actor-badge gov-history-actor-' + event.actor;
        actorBadge.textContent = capitalizeFirst(event.actor);
        actorTd.appendChild(actorBadge);
        row.appendChild(actorTd);

        // Summary
        var summaryTd = document.createElement('td');
        summaryTd.className = 'gov-history-summary';
        summaryTd.textContent = event.summary;
        row.appendChild(summaryTd);

        // Details chevron
        var detailsTd = document.createElement('td');
        detailsTd.className = 'gov-history-details-cell';
        var chevron = document.createElement('span');
        chevron.className = 'gov-history-chevron';
        chevron.textContent = '›';
        detailsTd.appendChild(chevron);
        row.appendChild(detailsTd);

        // Click handler to open drawer
        row.onclick = function() {
            state.governanceHistory.selectedEvent = event;
            renderApp();
        };
        row.onkeydown = function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                state.governanceHistory.selectedEvent = event;
                renderApp();
            }
        };

        tbody.appendChild(row);
    });
    table.appendChild(tbody);
    tableWrapper.appendChild(table);
    container.appendChild(tableWrapper);

    // Load more button
    if (state.governanceHistory.pagination.hasMore) {
        var loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'btn gov-history-load-more';
        loadMoreBtn.textContent = 'Load More';
        loadMoreBtn.onclick = function() {
            state.governanceHistory.pagination.offset += state.governanceHistory.pagination.limit;
            fetchGovernanceHistory();
        };
        container.appendChild(loadMoreBtn);
    }

    // History Event Drawer
    if (state.governanceHistory.selectedEvent) {
        container.appendChild(renderGovernanceHistoryDrawer(state.governanceHistory.selectedEvent));
    }

    return container;
}

/**
 * VTID-0408: Renders the History Event Drawer.
 */
function renderGovernanceHistoryDrawer(event) {
    var drawer = document.createElement('div');
    drawer.className = 'gov-history-drawer open';

    // Header
    var header = document.createElement('div');
    header.className = 'gov-history-drawer-header';

    var title = document.createElement('h2');
    title.className = 'gov-history-drawer-title';
    title.textContent = formatHistoryType(event.type);
    header.appendChild(title);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'drawer-close-btn';
    closeBtn.innerHTML = '×';
    closeBtn.onclick = function() {
        state.governanceHistory.selectedEvent = null;
        renderApp();
    };
    header.appendChild(closeBtn);

    drawer.appendChild(header);

    // Drawer content
    var content = document.createElement('div');
    content.className = 'gov-history-drawer-content';

    // Timestamp
    var timestampSection = document.createElement('div');
    timestampSection.className = 'gov-history-drawer-section';
    timestampSection.innerHTML = '<h3>Timestamp</h3><p>' + formatHistoryTimestamp(event.timestamp) + '</p>';
    content.appendChild(timestampSection);

    // Meta badges (level, actor)
    var metaSection = document.createElement('div');
    metaSection.className = 'gov-history-drawer-meta';

    if (event.level) {
        var levelBadge = document.createElement('span');
        levelBadge.className = 'level-badge level-' + event.level.toLowerCase();
        levelBadge.textContent = event.level;
        metaSection.appendChild(levelBadge);
    }

    var actorBadge = document.createElement('span');
    actorBadge.className = 'gov-history-actor-badge gov-history-actor-' + event.actor;
    actorBadge.textContent = capitalizeFirst(event.actor);
    metaSection.appendChild(actorBadge);

    var typeBadge = document.createElement('span');
    typeBadge.className = 'gov-history-type-badge ' + getHistoryTypeBadgeClass(event.type);
    typeBadge.textContent = formatHistoryType(event.type);
    metaSection.appendChild(typeBadge);

    content.appendChild(metaSection);

    // Summary
    var summarySection = document.createElement('div');
    summarySection.className = 'gov-history-drawer-section';
    summarySection.innerHTML = '<h3>Summary</h3><p>' + escapeHtml(event.summary) + '</p>';
    content.appendChild(summarySection);

    // Rule IDs as chips (if present in details)
    if (event.details && event.details.violations && event.details.violations.length > 0) {
        var rulesSection = document.createElement('div');
        rulesSection.className = 'gov-history-drawer-section';
        rulesSection.innerHTML = '<h3>Violated Rules</h3>';

        var rulesContainer = document.createElement('div');
        rulesContainer.className = 'gov-history-rules-chips';

        event.details.violations.forEach(function(violation) {
            var chip = document.createElement('span');
            chip.className = 'gov-rule-chip gov-rule-chip-' + (violation.level || 'l2').toLowerCase();
            chip.innerHTML = '<span class="gov-rule-chip-id">' + escapeHtml(violation.rule_id) + '</span>' +
                '<span class="gov-rule-chip-level">' + (violation.level || 'L2') + '</span>';
            chip.title = violation.message || 'Click to view rule details';
            chip.onclick = function(e) {
                e.stopPropagation();
                openRuleDetailByCode(violation.rule_id);
            };
            rulesContainer.appendChild(chip);
        });

        rulesSection.appendChild(rulesContainer);
        content.appendChild(rulesSection);
    }

    // Service / VTID info
    if (event.details && (event.details.service || event.details.vtid)) {
        var contextSection = document.createElement('div');
        contextSection.className = 'gov-history-drawer-section';
        contextSection.innerHTML = '<h3>Context</h3>';

        var contextList = document.createElement('div');
        contextList.className = 'gov-history-context-list';

        if (event.details.vtid) {
            var vtidItem = document.createElement('div');
            vtidItem.className = 'gov-history-context-item';
            vtidItem.innerHTML = '<span class="label">VTID:</span><span class="value">' + escapeHtml(event.details.vtid) + '</span>';
            contextList.appendChild(vtidItem);
        }
        if (event.details.service) {
            var serviceItem = document.createElement('div');
            serviceItem.className = 'gov-history-context-item';
            serviceItem.innerHTML = '<span class="label">Service:</span><span class="value">' + escapeHtml(event.details.service) + '</span>';
            contextList.appendChild(serviceItem);
        }

        contextSection.appendChild(contextList);
        content.appendChild(contextSection);
    }

    // Raw JSON details
    var jsonSection = document.createElement('div');
    jsonSection.className = 'gov-history-drawer-section gov-history-json-section';
    jsonSection.innerHTML = '<h3>Raw Details</h3>';

    var jsonPre = document.createElement('pre');
    jsonPre.className = 'gov-history-json';
    jsonPre.textContent = JSON.stringify(event.details || {}, null, 2);
    jsonSection.appendChild(jsonPre);
    content.appendChild(jsonSection);

    drawer.appendChild(content);

    return drawer;
}

// --- VTID-0409: Governance Categories (Read-Only V1) ---

/**
 * VTID-0409: Fetches governance categories from the API.
 * Populates state.governanceCategories with category data including rules.
 */
async function fetchGovernanceCategories() {
    state.governanceCategories.loading = true;
    state.governanceCategories.fetched = true;
    state.governanceCategories.error = null;
    renderApp();

    try {
        var response = await fetch('/api/v1/governance/categories');
        var json = await response.json();

        if (json.ok && json.categories) {
            state.governanceCategories.items = json.categories;

            // Auto-select first category if none selected
            if (!state.governanceCategories.selectedCategoryId && json.categories.length > 0) {
                state.governanceCategories.selectedCategoryId = json.categories[0].id;
            }

            console.log('[VTID-0409] Governance categories loaded:', json.categories.length, 'categories');
        } else {
            throw new Error(json.error || 'Failed to load governance categories');
        }
    } catch (error) {
        console.warn('[VTID-0409] Governance categories fetch error:', error);
        state.governanceCategories.error = error.message;
        state.governanceCategories.items = [];
    }

    state.governanceCategories.loading = false;
    renderApp();
}

/**
 * VTID-0409: Renders the Governance Categories view.
 * Two-column layout: left = category list, right = rules table for selected category.
 */
function renderGovernanceCategoriesView() {
    var container = document.createElement('div');
    container.className = 'gov-categories-container';

    // Auto-fetch categories if not yet fetched and not currently loading
    if (!state.governanceCategories.fetched && !state.governanceCategories.loading) {
        fetchGovernanceCategories();
    }

    // Loading state
    if (state.governanceCategories.loading) {
        var loading = document.createElement('div');
        loading.className = 'gov-categories-loading';
        loading.innerHTML = '<div class="skeleton-table">' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '<div class="skeleton-row"></div>' +
            '</div>';
        container.appendChild(loading);
        return container;
    }

    // Error state
    if (state.governanceCategories.error) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'gov-categories-error';
        errorDiv.innerHTML = '<span class="error-icon">⚠</span> Error loading categories: ' + escapeHtml(state.governanceCategories.error);
        container.appendChild(errorDiv);
        return container;
    }

    // Empty state
    if (state.governanceCategories.items.length === 0) {
        var emptyDiv = document.createElement('div');
        emptyDiv.className = 'gov-categories-empty';
        emptyDiv.innerHTML = '<p>No governance categories found.</p>' +
            '<p class="gov-categories-empty-hint">Categories will appear here as governance rules are added.</p>';
        container.appendChild(emptyDiv);
        return container;
    }

    // Two-column layout
    var layout = document.createElement('div');
    layout.className = 'gov-categories-layout';

    // Left column: category list
    var leftColumn = document.createElement('div');
    leftColumn.className = 'gov-categories-list';

    var selectedId = state.governanceCategories.selectedCategoryId;
    var selectedCategory = state.governanceCategories.items.find(function(c) {
        return c.id === selectedId;
    }) || state.governanceCategories.items[0];

    state.governanceCategories.items.forEach(function(cat) {
        var catBtn = document.createElement('button');
        catBtn.className = 'gov-category-item' + (cat.id === selectedCategory.id ? ' selected' : '');
        catBtn.setAttribute('role', 'option');
        catBtn.setAttribute('aria-selected', cat.id === selectedCategory.id ? 'true' : 'false');

        var labelDiv = document.createElement('div');
        labelDiv.className = 'gov-category-label';
        labelDiv.textContent = cat.label;
        catBtn.appendChild(labelDiv);

        var metaDiv = document.createElement('div');
        metaDiv.className = 'gov-category-meta';

        var countSpan = document.createElement('span');
        countSpan.className = 'gov-category-count';
        countSpan.textContent = cat.rule_count + ' rule' + (cat.rule_count !== 1 ? 's' : '');
        metaDiv.appendChild(countSpan);

        var levelsSpan = document.createElement('span');
        levelsSpan.className = 'gov-category-levels';
        levelsSpan.innerHTML =
            '<span class="lvl lvl-L1" title="L1 Critical">' + cat.levels.L1 + '</span>' +
            '<span class="lvl lvl-L2" title="L2 High">' + cat.levels.L2 + '</span>' +
            '<span class="lvl lvl-L3" title="L3 Medium">' + cat.levels.L3 + '</span>' +
            '<span class="lvl lvl-L4" title="L4 Low">' + cat.levels.L4 + '</span>';
        metaDiv.appendChild(levelsSpan);

        catBtn.appendChild(metaDiv);

        catBtn.onclick = function() {
            state.governanceCategories.selectedCategoryId = cat.id;
            renderApp();
        };

        leftColumn.appendChild(catBtn);
    });

    layout.appendChild(leftColumn);

    // Right column: rules table for selected category
    var rightColumn = document.createElement('div');
    rightColumn.className = 'gov-category-rules';

    // Category header
    var catHeader = document.createElement('div');
    catHeader.className = 'gov-category-header';

    var catTitle = document.createElement('h3');
    catTitle.className = 'gov-category-title';
    catTitle.textContent = selectedCategory.label;
    catHeader.appendChild(catTitle);

    var catCount = document.createElement('span');
    catCount.className = 'gov-category-rule-count';
    catCount.textContent = selectedCategory.rule_count + ' rule' + (selectedCategory.rule_count !== 1 ? 's' : '');
    catHeader.appendChild(catCount);

    rightColumn.appendChild(catHeader);

    // Rules table
    if (selectedCategory.rules && selectedCategory.rules.length > 0) {
        var tableWrapper = document.createElement('div');
        tableWrapper.className = 'gov-category-table-wrapper';

        var table = document.createElement('table');
        table.className = 'gov-category-rules-table';

        // Table header
        var thead = document.createElement('thead');
        thead.innerHTML =
            '<tr>' +
            '<th>Rule ID</th>' +
            '<th>Title</th>' +
            '<th>Level</th>' +
            '<th>Source</th>' +
            '<th></th>' +
            '</tr>';
        table.appendChild(thead);

        // Table body
        var tbody = document.createElement('tbody');
        selectedCategory.rules.forEach(function(rule) {
            var row = document.createElement('tr');
            row.className = 'gov-category-rule-row';
            row.tabIndex = 0;
            row.setAttribute('role', 'button');
            row.setAttribute('aria-label', 'View rule details: ' + rule.rule_id);

            // Rule ID
            var idCell = document.createElement('td');
            idCell.className = 'gov-rule-id';
            idCell.textContent = rule.rule_id;
            row.appendChild(idCell);

            // Title
            var titleCell = document.createElement('td');
            titleCell.className = 'gov-rule-title';
            titleCell.textContent = rule.title;
            row.appendChild(titleCell);

            // Level badge
            var levelCell = document.createElement('td');
            levelCell.className = 'gov-rule-level-cell';
            var levelBadge = document.createElement('span');
            levelBadge.className = 'gov-rule-level lvl-' + rule.level;
            levelBadge.textContent = rule.level;
            levelCell.appendChild(levelBadge);
            row.appendChild(levelCell);

            // Source badge
            var sourceCell = document.createElement('td');
            sourceCell.className = 'gov-rule-source-cell';
            var sourceBadge = document.createElement('span');
            sourceBadge.className = 'gov-rule-source source-' + rule.source.toLowerCase();
            sourceBadge.textContent = rule.source;
            sourceCell.appendChild(sourceBadge);
            row.appendChild(sourceCell);

            // Chevron
            var chevronCell = document.createElement('td');
            chevronCell.className = 'gov-rule-chevron';
            chevronCell.innerHTML = '›';
            row.appendChild(chevronCell);

            // Click handler to open rule drawer
            row.onclick = function() {
                openRuleDetailByCode(rule.rule_id);
            };
            row.onkeydown = function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openRuleDetailByCode(rule.rule_id);
                }
            };

            tbody.appendChild(row);
        });

        table.appendChild(tbody);
        tableWrapper.appendChild(table);
        rightColumn.appendChild(tableWrapper);
    } else {
        var noRules = document.createElement('div');
        noRules.className = 'gov-categories-empty';
        noRules.innerHTML = '<p>No rules in this category.</p>';
        rightColumn.appendChild(noRules);
    }

    layout.appendChild(rightColumn);
    container.appendChild(layout);

    return container;
}

/**
 * VTID-0408: Format timestamp for history display.
 */
function formatHistoryTimestamp(dateStr) {
    if (!dateStr) return '-';
    try {
        var date = new Date(dateStr);
        return date.toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return dateStr;
    }
}

/**
 * VTID-0408: Format event type for display.
 */
function formatHistoryType(type) {
    var typeMap = {
        'governance.deploy.blocked': 'Blocked',
        'governance.deploy.allowed': 'Allowed',
        'governance.evaluate': 'Evaluate',
        'governance.rule.created': 'Rule Created',
        'governance.rule.updated': 'Rule Updated',
        'governance.violated': 'Violation'
    };
    return typeMap[type] || type;
}

/**
 * VTID-0408: Get CSS class for type badge.
 */
function getHistoryTypeBadgeClass(type) {
    var classMap = {
        'governance.deploy.blocked': 'gov-history-type-blocked',
        'governance.deploy.allowed': 'gov-history-type-allowed',
        'governance.evaluate': 'gov-history-type-evaluate',
        'governance.rule.created': 'gov-history-type-rule',
        'governance.rule.updated': 'gov-history-type-rule',
        'governance.violated': 'gov-history-type-blocked'
    };
    return classMap[type] || 'gov-history-type-default';
}

/**
 * VTID-0408: Capitalize first letter of string.
 */
function capitalizeFirst(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// --- VTID-0600: Operational Visibility Views ---

/**
 * VTID-0600: Renders the OASIS > Events view with auto-refresh, severity colors, and drawer.
 */
function renderOasisEventsView() {
    var container = document.createElement('div');
    container.className = 'oasis-events-container';

    // Auto-fetch events if not yet fetched
    if (!state.oasisEvents.fetched && !state.oasisEvents.loading) {
        fetchOasisEvents(state.oasisEvents.filters);
        startOasisEventsAutoRefresh();
    }

    // Toolbar
    var toolbar = document.createElement('div');
    toolbar.className = 'oasis-events-toolbar';

    // Auto-refresh toggle
    var refreshToggle = document.createElement('div');
    refreshToggle.className = 'auto-refresh-toggle';

    var refreshLabel = document.createElement('span');
    refreshLabel.textContent = 'Auto-refresh (5s):';
    refreshToggle.appendChild(refreshLabel);

    var refreshBtn = document.createElement('button');
    refreshBtn.className = state.oasisEvents.autoRefreshEnabled ? 'btn btn-sm btn-active' : 'btn btn-sm';
    refreshBtn.textContent = state.oasisEvents.autoRefreshEnabled ? 'ON' : 'OFF';
    refreshBtn.onclick = function() {
        if (state.oasisEvents.autoRefreshEnabled) {
            stopOasisEventsAutoRefresh();
        } else {
            startOasisEventsAutoRefresh();
        }
        renderApp();
    };
    refreshToggle.appendChild(refreshBtn);
    toolbar.appendChild(refreshToggle);

    // Topic filter
    var topicFilter = document.createElement('select');
    topicFilter.className = 'form-control filter-select';
    topicFilter.innerHTML =
        '<option value="">All Topics</option>' +
        '<option value="deploy">Deploy</option>' +
        '<option value="governance">Governance</option>' +
        '<option value="cicd">CI/CD</option>' +
        '<option value="autopilot">Autopilot</option>' +
        '<option value="operator">Operator</option>';
    topicFilter.value = state.oasisEvents.filters.topic || '';
    topicFilter.onchange = function(e) {
        state.oasisEvents.filters.topic = e.target.value;
        fetchOasisEvents(state.oasisEvents.filters);
    };
    toolbar.appendChild(topicFilter);

    // Status filter
    var statusFilter = document.createElement('select');
    statusFilter.className = 'form-control filter-select';
    statusFilter.innerHTML =
        '<option value="">All Status</option>' +
        '<option value="success">Success</option>' +
        '<option value="error">Error</option>' +
        '<option value="info">Info</option>' +
        '<option value="warning">Warning</option>';
    statusFilter.value = state.oasisEvents.filters.status || '';
    statusFilter.onchange = function(e) {
        state.oasisEvents.filters.status = e.target.value;
        fetchOasisEvents(state.oasisEvents.filters);
    };
    toolbar.appendChild(statusFilter);

    // Spacer
    var spacer = document.createElement('div');
    spacer.className = 'spacer';
    toolbar.appendChild(spacer);

    // Refresh button
    var manualRefresh = document.createElement('button');
    manualRefresh.className = 'btn';
    manualRefresh.textContent = 'Refresh Now';
    manualRefresh.onclick = function() {
        fetchOasisEvents(state.oasisEvents.filters);
    };
    toolbar.appendChild(manualRefresh);

    container.appendChild(toolbar);

    // Live indicator
    if (state.oasisEvents.autoRefreshEnabled) {
        var liveIndicator = document.createElement('div');
        liveIndicator.className = 'oasis-live-indicator';
        liveIndicator.innerHTML = '<span class="live-dot"></span> LIVE - Auto-refreshing every 5 seconds';
        container.appendChild(liveIndicator);
    }

    // Events table
    var content = document.createElement('div');
    content.className = 'oasis-events-content';

    if (state.oasisEvents.loading && state.oasisEvents.items.length === 0) {
        content.innerHTML = '<div class="placeholder-content">Loading OASIS events...</div>';
    } else if (state.oasisEvents.error) {
        content.innerHTML = '<div class="placeholder-content error-text">Error: ' + state.oasisEvents.error + '</div>';
    } else if (state.oasisEvents.items.length === 0) {
        content.innerHTML = '<div class="placeholder-content">No events found.</div>';
    } else {
        var table = document.createElement('table');
        table.className = 'oasis-events-table';

        // Header
        var thead = document.createElement('thead');
        var headerRow = document.createElement('tr');
        ['Severity', 'Timestamp', 'Topic', 'VTID', 'Service', 'Status', 'Message'].forEach(function(header) {
            var th = document.createElement('th');
            th.textContent = header;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body
        var tbody = document.createElement('tbody');
        state.oasisEvents.items.forEach(function(event) {
            var row = document.createElement('tr');
            row.className = 'oasis-event-row';
            var severity = getEventSeverity(event);
            row.dataset.severity = severity;
            row.onclick = function() {
                state.oasisEvents.selectedEvent = event;
                renderApp();
            };

            // Severity indicator
            var severityCell = document.createElement('td');
            var severityDot = document.createElement('span');
            severityDot.className = 'severity-dot severity-' + severity;
            severityCell.appendChild(severityDot);
            row.appendChild(severityCell);

            // Timestamp
            var tsCell = document.createElement('td');
            tsCell.className = 'event-timestamp';
            tsCell.textContent = formatEventTimestamp(event.created_at);
            row.appendChild(tsCell);

            // Topic
            var topicCell = document.createElement('td');
            topicCell.className = 'event-topic';
            topicCell.textContent = event.topic || '-';
            row.appendChild(topicCell);

            // VTID
            var vtidCell = document.createElement('td');
            vtidCell.className = 'event-vtid';
            vtidCell.textContent = event.vtid || '-';
            row.appendChild(vtidCell);

            // Service
            var serviceCell = document.createElement('td');
            serviceCell.className = 'event-service';
            serviceCell.textContent = event.service || '-';
            row.appendChild(serviceCell);

            // Status
            var statusCell = document.createElement('td');
            var statusBadge = document.createElement('span');
            statusBadge.className = 'status-badge status-' + (event.status || 'info');
            statusBadge.textContent = event.status || '-';
            statusCell.appendChild(statusBadge);
            row.appendChild(statusCell);

            // Message
            var msgCell = document.createElement('td');
            msgCell.className = 'event-message';
            msgCell.textContent = (event.message || '').substring(0, 60) + ((event.message || '').length > 60 ? '...' : '');
            row.appendChild(msgCell);

            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        content.appendChild(table);
    }

    container.appendChild(content);

    return container;
}

/**
 * VTID-0600: Renders the OASIS Event Detail Drawer.
 */
function renderOasisEventDrawer() {
    var drawer = document.createElement('div');
    drawer.className = 'drawer oasis-event-drawer' + (state.oasisEvents.selectedEvent ? ' open' : '');

    if (!state.oasisEvents.selectedEvent) {
        return drawer;
    }

    var event = state.oasisEvents.selectedEvent;
    var severity = getEventSeverity(event);

    // Header
    var header = document.createElement('div');
    header.className = 'drawer-header';

    var title = document.createElement('h3');
    title.textContent = 'Event Details';
    header.appendChild(title);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'drawer-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = function() {
        state.oasisEvents.selectedEvent = null;
        renderApp();
    };
    header.appendChild(closeBtn);
    drawer.appendChild(header);

    // Content
    var content = document.createElement('div');
    content.className = 'drawer-content';

    // Severity banner
    var severityBanner = document.createElement('div');
    severityBanner.className = 'severity-banner severity-banner-' + severity;
    severityBanner.textContent = severity.toUpperCase() + ' SEVERITY';
    content.appendChild(severityBanner);

    // Fields
    var fields = [
        { label: 'Event ID', value: event.id },
        { label: 'Timestamp', value: formatEventTimestamp(event.created_at) },
        { label: 'Topic', value: event.topic },
        { label: 'VTID', value: event.vtid },
        { label: 'Service', value: event.service },
        { label: 'Status', value: event.status },
        { label: 'Role', value: event.role },
        { label: 'Model', value: event.model },
        { label: 'Message', value: event.message }
    ];

    fields.forEach(function(field) {
        if (field.value) {
            var row = document.createElement('div');
            row.className = 'drawer-field';

            var label = document.createElement('div');
            label.className = 'drawer-field-label';
            label.textContent = field.label;
            row.appendChild(label);

            var value = document.createElement('div');
            value.className = 'drawer-field-value';
            value.textContent = field.value;
            row.appendChild(value);

            content.appendChild(row);
        }
    });

    // Metadata section
    if (event.metadata && Object.keys(event.metadata).length > 0) {
        var metaSection = document.createElement('div');
        metaSection.className = 'drawer-section';

        var metaTitle = document.createElement('h4');
        metaTitle.textContent = 'Metadata';
        metaSection.appendChild(metaTitle);

        var metaPre = document.createElement('pre');
        metaPre.className = 'drawer-metadata';
        metaPre.textContent = JSON.stringify(event.metadata, null, 2);
        metaSection.appendChild(metaPre);

        content.appendChild(metaSection);
    }

    drawer.appendChild(content);

    return drawer;
}

/**
 * VTID-0600: Renders the Command Hub > Events view (curated operational events).
 */
function renderCommandHubEventsView() {
    var container = document.createElement('div');
    container.className = 'command-hub-events-container';

    // Auto-fetch events if not yet fetched
    if (!state.commandHubEvents.fetched && !state.commandHubEvents.loading) {
        fetchCommandHubEvents();
    }

    // Header
    var header = document.createElement('div');
    header.className = 'command-hub-events-header';

    var title = document.createElement('h2');
    title.textContent = 'Operational Events';
    header.appendChild(title);

    var subtitle = document.createElement('p');
    subtitle.className = 'section-subtitle';
    subtitle.textContent = 'Curated events for supervisor oversight: deployments, governance decisions, CI/CD, and autopilot activity.';
    header.appendChild(subtitle);

    container.appendChild(header);

    // Filters toolbar
    var toolbar = document.createElement('div');
    toolbar.className = 'command-hub-events-toolbar';

    // Topic filter
    var topicFilter = document.createElement('select');
    topicFilter.className = 'form-control filter-select';
    topicFilter.innerHTML =
        '<option value="">All Types</option>' +
        '<option value="deploy">Deployments</option>' +
        '<option value="governance">Governance</option>' +
        '<option value="cicd">CI/CD</option>' +
        '<option value="autopilot">Autopilot</option>' +
        '<option value="operator">Operator</option>';
    topicFilter.value = state.commandHubEvents.filters.topic || '';
    topicFilter.onchange = function(e) {
        state.commandHubEvents.filters.topic = e.target.value;
        fetchCommandHubEvents();
    };
    toolbar.appendChild(topicFilter);

    // Status filter
    var statusFilter = document.createElement('select');
    statusFilter.className = 'form-control filter-select';
    statusFilter.innerHTML =
        '<option value="">All Status</option>' +
        '<option value="success">Success</option>' +
        '<option value="error">Error/Blocked</option>' +
        '<option value="info">Info</option>';
    statusFilter.value = state.commandHubEvents.filters.status || '';
    statusFilter.onchange = function(e) {
        state.commandHubEvents.filters.status = e.target.value;
        fetchCommandHubEvents();
    };
    toolbar.appendChild(statusFilter);

    // Spacer
    var spacer = document.createElement('div');
    spacer.className = 'spacer';
    toolbar.appendChild(spacer);

    // Refresh button
    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.onclick = function() {
        fetchCommandHubEvents();
    };
    toolbar.appendChild(refreshBtn);

    container.appendChild(toolbar);

    // Events list
    var content = document.createElement('div');
    content.className = 'command-hub-events-content';

    if (state.commandHubEvents.loading) {
        content.innerHTML = '<div class="placeholder-content">Loading operational events...</div>';
    } else if (state.commandHubEvents.error) {
        content.innerHTML = '<div class="placeholder-content error-text">Error: ' + state.commandHubEvents.error + '</div>';
    } else if (state.commandHubEvents.items.length === 0) {
        content.innerHTML = '<div class="placeholder-content">No operational events found.</div>';
    } else {
        var table = document.createElement('table');
        table.className = 'command-hub-events-table';

        var thead = document.createElement('thead');
        var headerRow = document.createElement('tr');
        ['Priority', 'Time', 'Type', 'VTID', 'Status', 'Summary'].forEach(function(h) {
            var th = document.createElement('th');
            th.textContent = h;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');
        state.commandHubEvents.items.forEach(function(event) {
            var row = document.createElement('tr');
            var severity = getEventSeverity(event);
            row.className = 'command-hub-event-row severity-row-' + severity;

            // Priority indicator
            var prioCell = document.createElement('td');
            var prioDot = document.createElement('span');
            prioDot.className = 'severity-dot severity-' + severity;
            prioCell.appendChild(prioDot);
            row.appendChild(prioCell);

            // Time
            var timeCell = document.createElement('td');
            timeCell.textContent = formatEventTimestamp(event.created_at);
            row.appendChild(timeCell);

            // Type
            var typeCell = document.createElement('td');
            var typeBadge = document.createElement('span');
            typeBadge.className = 'event-type-badge';
            typeBadge.textContent = (event.topic || '').split('.')[0];
            typeCell.appendChild(typeBadge);
            row.appendChild(typeCell);

            // VTID
            var vtidCell = document.createElement('td');
            vtidCell.textContent = event.vtid || '-';
            row.appendChild(vtidCell);

            // Status
            var statusCell = document.createElement('td');
            var statusBadge = document.createElement('span');
            statusBadge.className = 'status-badge status-' + (event.status || 'info');
            statusBadge.textContent = event.status || '-';
            statusCell.appendChild(statusBadge);
            row.appendChild(statusCell);

            // Summary
            var summaryCell = document.createElement('td');
            summaryCell.textContent = event.message || '-';
            row.appendChild(summaryCell);

            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        content.appendChild(table);
    }

    container.appendChild(content);

    return container;
}

/**
 * DEV-COMHU-2025-0008: Shared VTID Ledger Table Renderer.
 * Creates a table from ledger API data with standardized columns.
 * Used by both Command Hub > VTIDs and OASIS > VTID Ledger views.
 *
 * @param {Array} items - VTID ledger items from API
 * @returns {HTMLTableElement} The rendered table
 */
function renderVtidLedgerTable(items) {
    var table = document.createElement('table');
    table.className = 'vtids-table';

    // Header row with required columns
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    ['VTID', 'Task Family', 'Module', 'Title', 'Status', 'Created', 'Last Event'].forEach(function(h) {
        var th = document.createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body rows
    var tbody = document.createElement('tbody');
    items.forEach(function(item) {
        var row = document.createElement('tr');
        row.className = 'vtid-row';

        // VTID column
        var vtidCell = document.createElement('td');
        vtidCell.className = 'vtid-cell';
        vtidCell.textContent = item.vtid || '—';
        row.appendChild(vtidCell);

        // Task Family column
        var familyCell = document.createElement('td');
        familyCell.textContent = item.task_family || '—';
        row.appendChild(familyCell);

        // Module column
        var moduleCell = document.createElement('td');
        moduleCell.textContent = item.task_module || '—';
        row.appendChild(moduleCell);

        // Title column
        var titleCell = document.createElement('td');
        titleCell.textContent = item.title || '—';
        row.appendChild(titleCell);

        // Status column
        var statusCell = document.createElement('td');
        var statusBadge = document.createElement('span');
        var statusVal = (item.status || 'unknown').toLowerCase();
        statusBadge.className = 'vtid-status-badge vtid-status-' + statusVal;
        statusBadge.textContent = item.status || 'unknown';
        statusCell.appendChild(statusBadge);
        row.appendChild(statusCell);

        // Created column
        var createdCell = document.createElement('td');
        createdCell.textContent = item.created_at ? formatEventTimestamp(item.created_at) : '—';
        row.appendChild(createdCell);

        // Last Event column (show "—" if null)
        var lastEventCell = document.createElement('td');
        lastEventCell.textContent = item.last_event_at ? formatEventTimestamp(item.last_event_at) : '—';
        row.appendChild(lastEventCell);

        tbody.appendChild(row);
    });
    table.appendChild(tbody);

    return table;
}

/**
 * DEV-COMHU-2025-0008: Renders the Command Hub > VTIDs view.
 * Uses authoritative VTID Ledger API instead of events-based grouping.
 */
function renderVtidsView() {
    var container = document.createElement('div');
    container.className = 'vtids-container';

    // Auto-fetch VTIDs from ledger if not yet fetched
    if (!state.vtidLedger.fetched && !state.vtidLedger.loading) {
        fetchVtidLedger();
    }

    // Header
    var header = document.createElement('div');
    header.className = 'vtids-header';

    var title = document.createElement('h2');
    title.textContent = 'VTIDs';
    header.appendChild(title);

    var subtitle = document.createElement('p');
    subtitle.className = 'section-subtitle';
    subtitle.textContent = 'All VTIDs from the authoritative ledger. Includes ledger-only VTIDs with no events.';
    header.appendChild(subtitle);

    container.appendChild(header);

    // Toolbar with Refresh button
    var toolbar = document.createElement('div');
    toolbar.className = 'vtids-toolbar';

    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.onclick = function() {
        state.vtidLedger.fetched = false;
        fetchVtidLedger();
    };
    toolbar.appendChild(refreshBtn);

    container.appendChild(toolbar);

    // Error banner (visible error, not console-only)
    if (state.vtidLedger.error) {
        var errorBanner = document.createElement('div');
        errorBanner.className = 'vtid-ledger-error-banner';
        errorBanner.textContent = 'Error loading VTIDs: ' + state.vtidLedger.error;
        container.appendChild(errorBanner);
    }

    // Status line: "Loaded N VTIDs from Ledger"
    var statusLine = document.createElement('div');
    statusLine.className = 'vtid-ledger-status-line';
    if (state.vtidLedger.loading) {
        statusLine.textContent = 'Loading VTIDs from Ledger...';
    } else if (state.vtidLedger.fetched && !state.vtidLedger.error) {
        statusLine.textContent = 'Loaded ' + state.vtidLedger.items.length + ' VTIDs from Ledger';
    } else if (!state.vtidLedger.fetched) {
        statusLine.textContent = 'VTIDs not yet loaded';
    }
    container.appendChild(statusLine);

    // Content
    var content = document.createElement('div');
    content.className = 'vtids-content';

    if (state.vtidLedger.loading) {
        content.innerHTML = '<div class="placeholder-content">Loading VTIDs from Ledger...</div>';
    } else if (state.vtidLedger.items.length === 0 && !state.vtidLedger.error) {
        content.innerHTML = '<div class="placeholder-content">No VTIDs found in ledger.</div>';
    } else if (state.vtidLedger.items.length > 0) {
        // Use shared table renderer
        content.appendChild(renderVtidLedgerTable(state.vtidLedger.items));
    }

    container.appendChild(content);

    return container;
}

/**
 * DEV-COMHU-2025-0009: Renders the OASIS > VTID Ledger view.
 * Uses the same authoritative VTID Ledger API as Command Hub > VTIDs.
 * Includes fingerprint for deployment verification.
 */
function renderOasisVtidLedgerView() {
    var container = document.createElement('div');
    container.className = 'vtids-container';

    // Auto-fetch VTIDs from ledger if not yet fetched
    if (!state.vtidLedger.fetched && !state.vtidLedger.loading) {
        fetchVtidLedger();
    }

    // Header - always rendered immediately
    var header = document.createElement('div');
    header.className = 'vtids-header';

    var title = document.createElement('h2');
    title.textContent = 'VTID Ledger';
    header.appendChild(title);

    // DEV-COMHU-2025-0009: Visible fingerprint for deployment proof
    var fingerprint = document.createElement('span');
    fingerprint.className = 'view-fingerprint';
    fingerprint.textContent = 'View: OASIS_VTID_LEDGER_ACTIVE (DEV-COMHU-2025-0009)';
    header.appendChild(fingerprint);

    var subtitle = document.createElement('p');
    subtitle.className = 'section-subtitle';
    subtitle.textContent = 'Authoritative VTID registry from OASIS. Shows all registered VTIDs including those with no events.';
    header.appendChild(subtitle);

    container.appendChild(header);

    // Toolbar with Refresh button
    var toolbar = document.createElement('div');
    toolbar.className = 'vtids-toolbar';

    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.onclick = function() {
        state.vtidLedger.fetched = false;
        fetchVtidLedger();
    };
    toolbar.appendChild(refreshBtn);

    container.appendChild(toolbar);

    // Error banner (visible error, not console-only)
    if (state.vtidLedger.error) {
        var errorBanner = document.createElement('div');
        errorBanner.className = 'vtid-ledger-error-banner';
        errorBanner.textContent = 'Error loading VTID Ledger: ' + state.vtidLedger.error;
        container.appendChild(errorBanner);
    }

    // Status line: "Loaded N VTIDs from Ledger"
    var statusLine = document.createElement('div');
    statusLine.className = 'vtid-ledger-status-line';
    if (state.vtidLedger.loading) {
        statusLine.textContent = 'Loading VTID Ledger...';
    } else if (state.vtidLedger.fetched && !state.vtidLedger.error) {
        statusLine.textContent = 'Loaded ' + state.vtidLedger.items.length + ' VTIDs from Ledger';
    } else if (!state.vtidLedger.fetched) {
        statusLine.textContent = 'Loading VTID Ledger...';
    }
    container.appendChild(statusLine);

    // Content - always render a visible block
    var content = document.createElement('div');
    content.className = 'vtids-content';

    if (state.vtidLedger.loading || (!state.vtidLedger.fetched && !state.vtidLedger.error)) {
        content.innerHTML = '<div class="placeholder-content">Loading VTID Ledger...</div>';
    } else if (state.vtidLedger.items.length === 0 && !state.vtidLedger.error) {
        content.innerHTML = '<div class="placeholder-content">No VTIDs found in ledger.</div>';
    } else if (state.vtidLedger.items.length > 0) {
        // Use shared table renderer
        content.appendChild(renderVtidLedgerTable(state.vtidLedger.items));
    }

    container.appendChild(content);

    return container;
}

/**
 * VTID-0601: Renders the Command Hub > Approvals view.
 * Shows pending PRs from Claude branches that can be merged/deployed.
 */
function renderApprovalsView() {
    var container = document.createElement('div');
    container.className = 'approvals-container';

    // Auto-fetch approvals if not yet fetched
    if (!state.approvals.fetched && !state.approvals.loading) {
        fetchApprovals();
    }

    // Header
    var header = document.createElement('div');
    header.className = 'approvals-header';

    var title = document.createElement('h2');
    title.textContent = 'Autonomous Safe Merge & Deploy';
    header.appendChild(title);

    var subtitle = document.createElement('p');
    subtitle.className = 'section-subtitle';
    subtitle.textContent = 'Review and approve pending PRs for merge and deploy. VTID-0601: No GitHub UI required.';
    header.appendChild(subtitle);

    // Refresh button
    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-secondary';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.style.marginTop = '8px';
    refreshBtn.onclick = function() {
        state.approvals.fetched = false;
        fetchApprovals();
    };
    header.appendChild(refreshBtn);

    container.appendChild(header);

    // Error display
    if (state.approvals.error) {
        var errorDiv = document.createElement('div');
        errorDiv.className = 'approvals-error';
        errorDiv.style.cssText = 'background: #3b1515; border: 1px solid #ef4444; padding: 12px; border-radius: 6px; margin-bottom: 16px; color: #fca5a5;';
        errorDiv.textContent = 'Error: ' + state.approvals.error;
        container.appendChild(errorDiv);
    }

    // Pending Approvals Section
    var pendingSection = document.createElement('div');
    pendingSection.className = 'approvals-section';

    var pendingHeader = document.createElement('div');
    pendingHeader.className = 'approvals-section-header';
    pendingHeader.innerHTML = '<span>⏳</span> Pending Approvals (' + state.approvals.items.length + ')';
    pendingSection.appendChild(pendingHeader);

    var pendingContent = document.createElement('div');
    pendingContent.className = 'approvals-section-content';

    if (state.approvals.loading) {
        pendingContent.innerHTML = '<div class="placeholder-content">Loading approvals from GitHub...</div>';
    } else if (state.approvals.items.length === 0) {
        // Empty state
        var emptyState = document.createElement('div');
        emptyState.className = 'approvals-empty-state';
        emptyState.style.cssText = 'text-align: center; padding: 40px 20px; color: #888;';
        emptyState.innerHTML = '<div style="font-size: 48px; margin-bottom: 16px;">✓</div>' +
            '<div style="font-size: 18px; margin-bottom: 8px;">No pending approvals</div>' +
            '<div style="font-size: 14px;">All PRs from Claude branches have been processed.</div>';
        pendingContent.appendChild(emptyState);
    } else {
        // Real approvals table
        var table = document.createElement('table');
        table.className = 'approvals-table';

        var thead = document.createElement('thead');
        var headerRow = document.createElement('tr');
        ['VTID', 'PR', 'Branch', 'Service', 'CI', 'Gov', 'Action', 'Actions'].forEach(function(h) {
            var th = document.createElement('th');
            th.textContent = h;
            th.style.textAlign = h === 'Actions' ? 'center' : 'left';
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');

        state.approvals.items.forEach(function(item) {
            var row = document.createElement('tr');

            // VTID
            var vtidCell = document.createElement('td');
            var vtidBadge = document.createElement('span');
            vtidBadge.className = 'vtid-badge';
            vtidBadge.style.cssText = 'background: #1e3a5f; color: #60a5fa; padding: 2px 8px; border-radius: 4px; font-family: monospace;';
            vtidBadge.textContent = item.vtid;
            vtidCell.appendChild(vtidBadge);
            row.appendChild(vtidCell);

            // PR number with link
            var prCell = document.createElement('td');
            var prLink = document.createElement('a');
            prLink.href = item.pr_url || '#';
            prLink.target = '_blank';
            prLink.style.color = '#60a5fa';
            prLink.textContent = '#' + item.pr_number;
            prLink.title = item.pr_title || '';
            prCell.appendChild(prLink);
            row.appendChild(prCell);

            // Branch
            var branchCell = document.createElement('td');
            branchCell.style.fontFamily = 'monospace';
            branchCell.style.fontSize = '12px';
            branchCell.textContent = item.branch ? (item.branch.length > 30 ? item.branch.substring(0, 30) + '...' : item.branch) : '-';
            branchCell.title = item.branch || '';
            row.appendChild(branchCell);

            // Service
            var serviceCell = document.createElement('td');
            if (item.service) {
                var serviceBadge = document.createElement('span');
                serviceBadge.style.cssText = 'background: #1e3a3f; color: #34d399; padding: 2px 6px; border-radius: 4px; font-size: 11px;';
                serviceBadge.textContent = item.service;
                serviceCell.appendChild(serviceBadge);
            } else {
                serviceCell.textContent = '-';
            }
            row.appendChild(serviceCell);

            // CI Status
            var ciCell = document.createElement('td');
            var ciIndicator = document.createElement('span');
            ciIndicator.style.cssText = 'display: inline-flex; align-items: center; gap: 4px;';
            if (item.ci_status === 'pass') {
                ciIndicator.innerHTML = '<span style="color: #22c55e;">✓</span> Pass';
            } else if (item.ci_status === 'fail') {
                ciIndicator.innerHTML = '<span style="color: #ef4444;">✗</span> Fail';
            } else if (item.ci_status === 'pending') {
                ciIndicator.innerHTML = '<span style="color: #f59e0b;">⋯</span> Pending';
            } else {
                ciIndicator.innerHTML = '<span style="color: #888;">?</span> Unknown';
            }
            ciCell.appendChild(ciIndicator);
            row.appendChild(ciCell);

            // Governance Status
            var govCell = document.createElement('td');
            var govIndicator = document.createElement('span');
            govIndicator.style.cssText = 'display: inline-flex; align-items: center; gap: 4px;';
            if (item.governance_status === 'pass') {
                govIndicator.innerHTML = '<span style="color: #22c55e;">✓</span> Pass';
            } else if (item.governance_status === 'fail') {
                govIndicator.innerHTML = '<span style="color: #ef4444;">✗</span> Blocked';
            } else {
                govIndicator.innerHTML = '<span style="color: #888;">?</span> Unknown';
            }
            govCell.appendChild(govIndicator);
            row.appendChild(govCell);

            // Action type
            var actionCell = document.createElement('td');
            var actionBadge = document.createElement('span');
            if (item.type === 'merge+deploy') {
                actionBadge.style.cssText = 'background: #4c1d95; color: #c4b5fd; padding: 2px 6px; border-radius: 4px; font-size: 11px;';
                actionBadge.textContent = 'MERGE+DEPLOY';
            } else if (item.type === 'deploy') {
                actionBadge.style.cssText = 'background: #1e3a3f; color: #34d399; padding: 2px 6px; border-radius: 4px; font-size: 11px;';
                actionBadge.textContent = 'DEPLOY';
            } else {
                actionBadge.style.cssText = 'background: #1e3a5f; color: #60a5fa; padding: 2px 6px; border-radius: 4px; font-size: 11px;';
                actionBadge.textContent = 'MERGE';
            }
            actionCell.appendChild(actionBadge);
            row.appendChild(actionCell);

            // Actions buttons
            var actionsCell = document.createElement('td');
            actionsCell.style.textAlign = 'center';

            var canApprove = item.ci_status === 'pass' && item.governance_status === 'pass';

            var approveBtn = document.createElement('button');
            approveBtn.className = 'btn btn-success btn-sm';
            approveBtn.textContent = '✓ Approve';
            approveBtn.style.cssText = 'padding: 4px 12px; font-size: 12px; margin-right: 8px;';
            approveBtn.disabled = !canApprove || state.approvals.loading;
            approveBtn.title = canApprove ? 'Merge PR' + (item.service ? ' and trigger deploy' : '') : 'CI or Governance not passed';
            approveBtn.onclick = function() {
                if (confirm('Approve PR #' + item.pr_number + '?\n\nThis will merge the PR' + (item.service ? ' and trigger a deploy to ' + item.service : '') + '.')) {
                    approveApprovalItem(item.id);
                }
            };
            actionsCell.appendChild(approveBtn);

            var denyBtn = document.createElement('button');
            denyBtn.className = 'btn btn-danger btn-sm';
            denyBtn.textContent = '✗ Deny';
            denyBtn.style.cssText = 'padding: 4px 12px; font-size: 12px;';
            denyBtn.disabled = state.approvals.loading;
            denyBtn.onclick = function() {
                var reason = prompt('Reason for denial (optional):');
                if (reason !== null) {
                    denyApprovalItem(item.id, reason);
                }
            };
            actionsCell.appendChild(denyBtn);

            row.appendChild(actionsCell);
            tbody.appendChild(row);
        });

        table.appendChild(tbody);
        pendingContent.appendChild(table);
    }

    pendingSection.appendChild(pendingContent);
    container.appendChild(pendingSection);

    // Info section
    var infoSection = document.createElement('div');
    infoSection.className = 'approvals-info';
    infoSection.style.cssText = 'margin-top: 24px; padding: 16px; background: #1a1a2e; border-radius: 8px; border: 1px solid #333;';
    infoSection.innerHTML = '<div style="font-weight: 600; margin-bottom: 8px;">VTID-0601 Workflow</div>' +
        '<div style="font-size: 13px; color: #888; line-height: 1.6;">' +
        '1. Claude creates PR on <code style="background: #2a2a3e; padding: 2px 6px; border-radius: 4px;">claude/*</code> branch<br>' +
        '2. CI runs automatically<br>' +
        '3. Governance evaluation runs<br>' +
        '4. <strong style="color: #fff;">You approve here</strong> → Vitana merges + deploys<br>' +
        '5. No GitHub UI or Cloud Shell required</div>';
    container.appendChild(infoSection);

    return container;
}

function renderDocsScreensView() {
    const container = document.createElement('div');
    container.className = 'docs-container';

    // Toolbar with role filters
    const toolbar = document.createElement('div');
    toolbar.className = 'docs-toolbar';

    const label = document.createElement('span');
    label.textContent = 'Role:';
    label.className = 'docs-toolbar-label';
    toolbar.appendChild(label);

    const roles = ['DEVELOPER', 'COMMUNITY', 'PATIENT', 'STAFF', 'PROFESSIONAL', 'ADMIN', 'FULL CATALOG'];
    roles.forEach(role => {
        const btn = document.createElement('button');
        btn.className = state.selectedRole === role ? 'btn role-btn-active' : 'btn';
        btn.textContent = role;
        btn.onclick = () => {
            state.selectedRole = role;
            renderApp();
        };
        toolbar.appendChild(btn);
    });

    container.appendChild(toolbar);

    // Content area
    const content = document.createElement('div');
    content.className = 'docs-content';

    if (state.screenInventoryLoading) {
        content.innerHTML = '<div class="placeholder-content">Loading screen inventory...</div>';
    } else if (state.screenInventoryError) {
        content.innerHTML = `<div class="placeholder-content error-text">Error: ${state.screenInventoryError}</div>`;
    } else if (!state.screenInventory) {
        content.innerHTML = '<div class="placeholder-content">No screen inventory data available.</div>';
        // Try to fetch it
        fetchScreenInventory();
    } else {
        // Render screen table
        const screens = state.screenInventory.screen_inventory?.screens || [];
        const filteredScreens = screens.filter(screen => {
            if (state.selectedRole === 'FULL CATALOG') return true;
            return screen.role.toUpperCase() === state.selectedRole;
        });

        const table = document.createElement('table');
        table.className = 'docs-table';

        // Header
        const thead = document.createElement('thead');
        thead.innerHTML = `
            <tr class="docs-table-header">
                <th class="docs-table-cell">Screen ID</th>
                <th class="docs-table-cell">Module</th>
                <th class="docs-table-cell">Tab</th>
                <th class="docs-table-cell">URL Path</th>
                <th class="docs-table-cell">Role</th>
            </tr>
        `;
        table.appendChild(thead);

        // Body
        const tbody = document.createElement('tbody');
        filteredScreens.forEach((screen, index) => {
            const tr = document.createElement('tr');
            if (index % 2 !== 0) tr.className = 'docs-table-row-alt';
            tr.innerHTML = `
                <td class="docs-table-cell">${screen.screen_id}</td>
                <td class="docs-table-cell">${screen.module}</td>
                <td class="docs-table-cell">${screen.tab}</td>
                <td class="docs-table-cell"><code class="docs-table-code">${screen.url_path}</code></td>
                <td class="docs-table-cell">${screen.role}</td>
            `;
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        const summary = document.createElement('div');
        summary.className = 'docs-summary';
        summary.textContent = `Showing ${filteredScreens.length} screens for ${state.selectedRole}`;
        content.appendChild(summary);

        content.appendChild(table);
    }

    container.appendChild(content);
    return container;
}

// --- Global Overlays (VTID-0508) ---

function renderHeartbeatOverlay() {
    const backdrop = document.createElement('div');
    backdrop.className = 'overlay-backdrop';
    backdrop.onclick = (e) => {
        if (e.target === backdrop) {
            state.isHeartbeatOpen = false;
            renderApp();
        }
    };

    const panel = document.createElement('div');
    panel.className = 'overlay-panel heartbeat-overlay';

    // Header
    const header = document.createElement('div');
    header.className = 'overlay-header';

    const titleBlock = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'overlay-title';
    title.textContent = 'Heartbeat';
    titleBlock.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.className = 'overlay-subtitle';
    subtitle.textContent = 'System status & telemetry (UI stub)';
    titleBlock.appendChild(subtitle);

    header.appendChild(titleBlock);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'overlay-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => {
        state.isHeartbeatOpen = false;
        renderApp();
    };
    header.appendChild(closeBtn);

    panel.appendChild(header);

    // Content
    const content = document.createElement('div');
    content.className = 'overlay-content';

    // Current Status Section
    const statusSection = document.createElement('div');
    statusSection.className = 'heartbeat-section';

    const statusTitle = document.createElement('div');
    statusTitle.className = 'heartbeat-section-title';
    statusTitle.textContent = 'Current Status';
    statusSection.appendChild(statusTitle);

    const statusBox = document.createElement('div');
    statusBox.className = 'heartbeat-status';

    const statusDot = document.createElement('div');
    statusDot.className = 'heartbeat-status-dot standby';
    statusBox.appendChild(statusDot);

    const statusText = document.createElement('span');
    statusText.textContent = 'Standby';
    statusBox.appendChild(statusText);

    statusSection.appendChild(statusBox);
    content.appendChild(statusSection);

    // Metrics Section
    const metricsSection = document.createElement('div');
    metricsSection.className = 'heartbeat-section';

    const metricsTitle = document.createElement('div');
    metricsTitle.className = 'heartbeat-section-title';
    metricsTitle.textContent = 'Metrics';
    metricsSection.appendChild(metricsTitle);

    const metricsGrid = document.createElement('div');
    metricsGrid.className = 'heartbeat-metrics';

    const metrics = [
        { label: 'Last beat', value: '–' },
        { label: 'Latency', value: '–' },
        { label: 'Uptime', value: '–' },
        { label: 'Connections', value: '–' }
    ];

    metrics.forEach(m => {
        const metric = document.createElement('div');
        metric.className = 'heartbeat-metric';

        const label = document.createElement('div');
        label.className = 'heartbeat-metric-label';
        label.textContent = m.label;
        metric.appendChild(label);

        const value = document.createElement('div');
        value.className = 'heartbeat-metric-value';
        value.textContent = m.value;
        metric.appendChild(value);

        metricsGrid.appendChild(metric);
    });

    metricsSection.appendChild(metricsGrid);
    content.appendChild(metricsSection);

    // Events Section
    const eventsSection = document.createElement('div');
    eventsSection.className = 'heartbeat-section';

    const eventsTitle = document.createElement('div');
    eventsTitle.className = 'heartbeat-section-title';
    eventsTitle.textContent = 'Recent Events';
    eventsSection.appendChild(eventsTitle);

    const eventsBox = document.createElement('div');
    eventsBox.className = 'heartbeat-events';
    eventsBox.textContent = 'No telemetry yet';
    eventsSection.appendChild(eventsBox);

    content.appendChild(eventsSection);

    panel.appendChild(content);
    backdrop.appendChild(panel);

    return backdrop;
}

function renderOperatorOverlay() {
    const backdrop = document.createElement('div');
    backdrop.className = 'overlay-backdrop';
    backdrop.onclick = (e) => {
        if (e.target === backdrop) {
            state.isOperatorOpen = false;
            renderApp();
        }
    };

    const panel = document.createElement('div');
    panel.className = 'overlay-panel operator-overlay';

    // Header
    const header = document.createElement('div');
    header.className = 'overlay-header';

    const titleBlock = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'overlay-title';
    title.textContent = 'Operator Console';
    titleBlock.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.className = 'overlay-subtitle';
    subtitle.textContent = 'Live events & chat';
    titleBlock.appendChild(subtitle);

    header.appendChild(titleBlock);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'overlay-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => {
        state.isOperatorOpen = false;
        renderApp();
    };
    header.appendChild(closeBtn);

    panel.appendChild(header);

    // Tabs
    const tabs = document.createElement('div');
    tabs.className = 'operator-tabs';

    const tabConfigs = [
        { key: 'chat', label: 'Chat' },
        { key: 'ticker', label: 'Live Ticker' },
        { key: 'history', label: 'History' }
    ];

    tabConfigs.forEach(t => {
        const tab = document.createElement('button');
        tab.className = `operator-tab ${state.operatorActiveTab === t.key ? 'active' : ''}`;
        tab.textContent = t.label;
        tab.onclick = () => {
            state.operatorActiveTab = t.key;
            renderApp();
        };
        tabs.appendChild(tab);
    });

    panel.appendChild(tabs);

    // Tab Content
    const tabContent = document.createElement('div');
    tabContent.className = 'operator-tab-content';

    if (state.operatorActiveTab === 'chat') {
        tabContent.appendChild(renderOperatorChat());
    } else if (state.operatorActiveTab === 'ticker') {
        tabContent.appendChild(renderOperatorTicker());
    } else if (state.operatorActiveTab === 'history') {
        tabContent.appendChild(renderOperatorHistory());
    }

    panel.appendChild(tabContent);
    backdrop.appendChild(panel);

    return backdrop;
}

function renderOperatorChat() {
    const container = document.createElement('div');
    container.className = 'chat-container';

    // Messages area
    const messages = document.createElement('div');
    messages.className = 'chat-messages';

    if (state.chatMessages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'chat-empty-state';
        empty.textContent = 'No messages yet. Start a conversation with the Operator.';
        messages.appendChild(empty);
    } else {
        // VTID-0526: Updated message rendering with new bubble styles
        state.chatMessages.forEach(msg => {
            // Determine message type: sent (user) or reply (system)
            const isSent = msg.type === 'user' || msg.type === 'sent';
            const isError = msg.isError || msg.error;

            // Create bubble element with appropriate classes
            const bubble = document.createElement('div');
            let bubbleClasses = 'message-bubble';
            if (isSent) {
                bubbleClasses += ' message-sent';
            } else {
                bubbleClasses += ' message-reply';
            }
            if (isError) {
                bubbleClasses += ' message-error';
            }
            bubble.className = bubbleClasses;
            bubble.textContent = msg.content || msg.text;
            messages.appendChild(bubble);

            // Show attachments if any
            if (msg.attachments && msg.attachments.length > 0) {
                const attachmentsEl = document.createElement('div');
                attachmentsEl.className = 'chat-message-attachments';
                msg.attachments.forEach(att => {
                    const chip = document.createElement('span');
                    chip.className = `attachment-chip attachment-${att.kind}`;
                    chip.textContent = att.name || att.oasis_ref;
                    attachmentsEl.appendChild(chip);
                });
                messages.appendChild(attachmentsEl);
            }

            // Timestamp element
            const time = document.createElement('div');
            time.className = 'timestamp';
            // Align timestamp with the message bubble
            if (isSent) {
                time.style.alignSelf = 'flex-end';
            }
            time.textContent = msg.timestamp;
            messages.appendChild(time);
        });
    }

    container.appendChild(messages);

    // Attachments preview
    if (state.chatAttachments.length > 0) {
        const attachmentsPreview = document.createElement('div');
        attachmentsPreview.className = 'chat-attachments-preview';

        state.chatAttachments.forEach((att, index) => {
            const chip = document.createElement('span');
            chip.className = `attachment-chip attachment-${att.kind}`;
            chip.innerHTML = `${att.name} <span class="attachment-remove" data-index="${index}">&times;</span>`;
            chip.querySelector('.attachment-remove').onclick = () => {
                state.chatAttachments.splice(index, 1);
                renderApp();
            };
            attachmentsPreview.appendChild(chip);
        });

        container.appendChild(attachmentsPreview);
    }

    // Input area
    const inputContainer = document.createElement('div');
    inputContainer.className = 'chat-input-container';

    // Attachment button with dropdown
    const attachBtn = document.createElement('div');
    attachBtn.className = 'chat-attach-btn';
    attachBtn.innerHTML = '&#128206;'; // Paperclip emoji
    attachBtn.title = 'Add attachment';

    // Attachment menu (hidden by default)
    const attachMenu = document.createElement('div');
    attachMenu.className = 'chat-attach-menu';
    attachMenu.innerHTML = `
        <div class="attach-option" data-kind="image">Image</div>
        <div class="attach-option" data-kind="video">Video</div>
        <div class="attach-option" data-kind="file">File</div>
    `;
    // Menu hidden by default via CSS .chat-attach-menu { display: none; }

    attachBtn.onclick = (e) => {
        e.stopPropagation();
        attachMenu.classList.toggle('menu-open');
    };

    // Handle attach menu clicks
    attachMenu.querySelectorAll('.attach-option').forEach(opt => {
        opt.onclick = (e) => {
            e.stopPropagation();
            const kind = opt.dataset.kind;
            attachMenu.classList.remove('menu-open');

            // Create file input
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            if (kind === 'image') fileInput.accept = 'image/*';
            else if (kind === 'video') fileInput.accept = 'video/*';

            fileInput.onchange = (e) => {
                const file = e.target.files[0];
                if (file) {
                    uploadOperatorFile(file, kind);
                }
            };
            fileInput.click();
        };
    });

    attachBtn.appendChild(attachMenu);
    inputContainer.appendChild(attachBtn);

    // Close menu on outside click
    document.addEventListener('click', () => {
        attachMenu.classList.remove('menu-open');
    });

    // Textarea for message
    const textarea = document.createElement('textarea');
    textarea.className = 'chat-textarea';
    textarea.placeholder = 'Type a message...';
    textarea.value = state.chatInputValue;
    textarea.rows = 2;
    // VTID-0526-D: Track typing state to prevent scroll/render interruptions
    textarea.oninput = (e) => {
        state.chatInputValue = e.target.value;
        state.chatIsTyping = true;
    };
    textarea.onkeydown = (e) => {
        state.chatIsTyping = true;
        if (e.key === 'Enter' && e.ctrlKey && state.chatInputValue.trim()) {
            e.preventDefault();
            sendChatMessage();
        }
    };
    textarea.onblur = () => {
        // Only reset typing flag when user leaves the input
        state.chatIsTyping = false;
    };
    inputContainer.appendChild(textarea);

    // Send button
    const sendBtn = document.createElement('button');
    sendBtn.className = 'chat-send-btn';
    sendBtn.textContent = state.chatSending ? 'Sending...' : 'Send';
    sendBtn.disabled = state.chatSending;
    sendBtn.onclick = () => {
        if (state.chatInputValue.trim() && !state.chatSending) {
            sendChatMessage();
        }
    };
    inputContainer.appendChild(sendBtn);

    container.appendChild(inputContainer);

    return container;
}

/**
 * @deprecated VTID-0525: No longer used - all messages go through /operator/command
 * The backend parses NL and decides if it's deploy, task, or chat.
 * Kept for reference only.
 */
function isDeployCommand(message) {
    // DEPRECATED: Not used anymore - backend handles command detection
    return false;
}

/**
 * @deprecated VTID-0525: No longer used - backend auto-creates VTIDs
 * The /operator/command endpoint creates VTIDs via the deploy orchestrator.
 * Kept for reference only.
 */
function generateCommandVtid() {
    // DEPRECATED: Not used anymore - backend auto-creates VTIDs
    return null;
}

/**
 * Format command result for display
 * VTID-0525: Operator Command Hub
 * Uses the `reply` field from the backend response
 */
function formatCommandResult(result) {
    // Use the operator reply from the backend
    // The backend generates a descriptive message for all command types (deploy, task, errors)
    if (result.reply) {
        return result.reply;
    }

    // Fallback for legacy responses or errors
    if (!result.ok) {
        return `Command Error: ${result.error || 'Unknown error'}`;
    }

    return 'Command processed';
}

async function sendChatMessage() {
    if (state.chatSending) return;

    // VTID-0526-D: Reset typing flag - user is done typing, now sending
    state.chatIsTyping = false;

    const now = new Date();
    const timestamp = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const messageText = state.chatInputValue.trim();

    if (!messageText) return;

    // Add user message
    state.chatMessages.push({
        type: 'user',
        content: messageText,
        timestamp: timestamp,
        attachments: [...state.chatAttachments]
    });

    // Prepare attachments for API
    const attachments = state.chatAttachments.map(a => ({
        oasis_ref: a.oasis_ref,
        kind: a.kind
    }));

    // Clear input and attachments
    state.chatInputValue = '';
    state.chatAttachments = [];
    state.chatSending = true;
    renderApp();

    // VTID-0526-D: Scroll to bottom after user message (safe - typing flag is reset)
    requestAnimationFrame(function() {
        var messagesContainer = document.querySelector('.chat-messages');
        if (messagesContainer) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    });

    try {
        // VTID-0539: Route to Knowledge Hub API first for NL answers
        // This provides doc-grounded responses for questions about Vitana
        console.log('[Operator] Sending query to Knowledge Hub:', messageText);

        const knowledgeResponse = await fetch('/api/v1/assistant/knowledge/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: messageText,
                role: 'operator',
                tenant: 'vitana',
                maxResults: 5
            })
        });

        let replyContent = '';
        let knowledgeDocs = [];
        let usedKnowledgeHub = false;

        if (knowledgeResponse.ok) {
            const knowledgeResult = await knowledgeResponse.json();
            console.log('[Operator] Knowledge Hub response:', knowledgeResult);

            if (knowledgeResult.ok && knowledgeResult.answer && knowledgeResult.answer.trim()) {
                // Knowledge Hub returned a valid answer
                replyContent = knowledgeResult.answer;
                knowledgeDocs = knowledgeResult.docs || [];
                usedKnowledgeHub = true;
                console.log('[Operator] Using Knowledge Hub answer with', knowledgeDocs.length, 'docs');
            }
        }

        // Fallback to operator/chat if Knowledge Hub didn't provide an answer
        if (!usedKnowledgeHub) {
            console.log('[Operator] Knowledge Hub unavailable, falling back to /api/v1/operator/chat');

            const response = await fetch('/api/v1/operator/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: messageText,
                    attachments: attachments.length > 0 ? attachments : undefined
                })
            });

            if (!response.ok) {
                throw new Error(`Chat request failed: ${response.status}`);
            }

            const result = await response.json();
            console.log('[Operator] Chat response:', result);

            // VTID-0537: Use the reply from the Gemini Operator Tools Bridge
            replyContent = result.reply || 'No response received';

            // VTID-0537: Check if a task was created via tools
            const hasCreatedTask = result.createdTask && result.createdTask.vtid;

            // Build enhanced content if task was created
            if (hasCreatedTask) {
                replyContent += `\n\n📋 Task Created: **${result.createdTask.vtid}**`;
                if (result.createdTask.title) {
                    replyContent += ` - ${result.createdTask.title}`;
                }
            }

            state.chatMessages.push({
                type: 'system',
                content: replyContent,
                timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                oasis_ref: result.oasis_ref,
                threadId: result.threadId,
                createdTask: result.createdTask,
                toolResults: result.toolResults,
                meta: result.meta
            });
        } else {
            // VTID-0539: Build message with Knowledge Hub response
            let displayContent = replyContent;

            // Add sources section if docs available
            if (knowledgeDocs.length > 0) {
                displayContent += '\n\n---\n**Sources:**';
                knowledgeDocs.forEach((doc, index) => {
                    displayContent += `\n${index + 1}. ${doc.title}`;
                });
            }

            state.chatMessages.push({
                type: 'system',
                content: displayContent,
                timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                knowledgeDocs: knowledgeDocs,
                isKnowledgeHub: true
            });
        }

    } catch (error) {
        console.error('[Operator] Chat error:', error);
        state.chatMessages.push({
            type: 'system',
            content: `Error: ${error.message}`,
            timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            isError: true
        });
    } finally {
        state.chatSending = false;
        renderApp();

        // VTID-0526-D: Single rAF for scroll + conditional focus after message complete
        requestAnimationFrame(function() {
            // Scroll to bottom to show the reply
            var messagesContainer = document.querySelector('.chat-messages');
            if (messagesContainer) {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }
            // Only re-focus if input lost focus during send
            var textarea = document.querySelector('.chat-textarea');
            if (textarea && document.activeElement !== textarea) {
                textarea.focus();
            }
        });
    }
}

function renderOperatorTicker() {
    const container = document.createElement('div');
    container.className = 'ticker-container';

    // Heartbeat status banner
    // VTID-0526-D: Show LIVE status and stage counters as soon as telemetry loads (no heartbeat required)
    const statusBanner = document.createElement('div');
    const hasStageCounters = state.stageCounters && (state.stageCounters.PLANNER > 0 || state.stageCounters.WORKER > 0 || state.stageCounters.VALIDATOR > 0 || state.stageCounters.DEPLOY > 0 || state.lastTelemetryRefresh);
    const isLive = state.operatorHeartbeatActive || hasStageCounters;
    statusBanner.className = isLive ? 'ticker-status-banner ticker-live' : 'ticker-status-banner ticker-standby';

    // VTID-0526-D: Show stage counters immediately from telemetry, even before heartbeat snapshot
    const counters = state.stageCounters;
    const snapshot = state.operatorHeartbeatSnapshot;

    if (isLive) {
        statusBanner.innerHTML = `
            <div class="ticker-status-row">
                <span class="ticker-status-label">Status:</span>
                <span class="ticker-status-value status-live">LIVE</span>
                <span class="ticker-status-label">Tasks:</span>
                <span class="ticker-status-value">${snapshot?.tasks?.total || counters.PLANNER + counters.WORKER + counters.VALIDATOR + counters.DEPLOY}</span>
                <span class="ticker-status-label">CICD:</span>
                <span class="ticker-status-value status-${snapshot?.cicd?.status || 'ok'}">${snapshot?.cicd?.status || 'OK'}</span>
            </div>
            <div class="ticker-status-row ticker-status-tasks">
                <span>Scheduled: ${snapshot?.tasks?.by_status?.scheduled || 0}</span>
                <span>In Progress: ${snapshot?.tasks?.by_status?.in_progress || 0}</span>
                <span>Completed: ${snapshot?.tasks?.by_status?.completed || 0}</span>
            </div>
            <div class="ticker-status-row ticker-stage-counters">
                <span class="stage-counter stage-planner" title="Planning stage events">
                    <span class="stage-icon">P</span>
                    <span class="stage-count">${counters.PLANNER}</span>
                </span>
                <span class="stage-counter stage-worker" title="Worker stage events">
                    <span class="stage-icon">W</span>
                    <span class="stage-count">${counters.WORKER}</span>
                </span>
                <span class="stage-counter stage-validator" title="Validator stage events">
                    <span class="stage-icon">V</span>
                    <span class="stage-count">${counters.VALIDATOR}</span>
                </span>
                <span class="stage-counter stage-deploy" title="Deploy stage events">
                    <span class="stage-icon">D</span>
                    <span class="stage-count">${counters.DEPLOY}</span>
                </span>
            </div>
        `;
    } else if (state.stageCountersLoading) {
        statusBanner.innerHTML = `
            <div class="ticker-status-row">
                <span class="ticker-status-value status-standby">LOADING</span>
                <span class="ticker-hint">Fetching telemetry...</span>
            </div>
        `;
    } else {
        statusBanner.innerHTML = `
            <div class="ticker-status-row">
                <span class="ticker-status-value status-standby">STANDBY</span>
                <span class="ticker-hint">Loading live events...</span>
            </div>
        `;
    }
    container.appendChild(statusBanner);

    // VTID-0600: Ticker filter toolbar
    var filterToolbar = document.createElement('div');
    filterToolbar.className = 'ticker-filter-toolbar';

    var collapseToggle = document.createElement('label');
    collapseToggle.className = 'ticker-collapse-toggle';
    var collapseCheckbox = document.createElement('input');
    collapseCheckbox.type = 'checkbox';
    collapseCheckbox.checked = state.tickerCollapseHeartbeat;
    collapseCheckbox.onchange = function() {
        state.tickerCollapseHeartbeat = collapseCheckbox.checked;
        renderApp();
    };
    collapseToggle.appendChild(collapseCheckbox);
    collapseToggle.appendChild(document.createTextNode(' Collapse heartbeat'));
    filterToolbar.appendChild(collapseToggle);

    var severityFilter = document.createElement('select');
    severityFilter.className = 'ticker-severity-filter';
    severityFilter.innerHTML =
        '<option value="all">All Events</option>' +
        '<option value="critical">Critical Only</option>' +
        '<option value="important">Important+</option>';
    severityFilter.value = state.tickerSeverityFilter;
    severityFilter.onchange = function() {
        state.tickerSeverityFilter = severityFilter.value;
        renderApp();
    };
    filterToolbar.appendChild(severityFilter);

    container.appendChild(filterToolbar);

    // Events list
    const eventsList = document.createElement('div');
    eventsList.className = 'ticker-events-list';

    if (state.tickerEvents.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ticker-empty';
        empty.textContent = state.operatorHeartbeatActive ? 'Waiting for events...' : 'Loading events...';
        eventsList.appendChild(empty);
    } else {
        // VTID-0600: Classify and sort events by severity
        var classifiedEvents = state.tickerEvents.map(function(event) {
            var eventCopy = Object.assign({}, event);
            // Determine severity from event type/content
            var type = (event.type || '').toLowerCase();
            var content = (event.content || '').toLowerCase();

            if (type === 'error' || content.includes('failed') || content.includes('blocked') || content.includes('denied')) {
                eventCopy.severity = 'critical';
            } else if (type === 'governance' || type === 'deploy' || content.includes('success') || content.includes('allowed')) {
                eventCopy.severity = 'important';
            } else if (type === 'heartbeat' || type === 'ping' || content.includes('heartbeat') || content.includes('health')) {
                eventCopy.severity = 'low';
            } else {
                eventCopy.severity = 'info';
            }
            return eventCopy;
        });

        // Filter by severity if filter is active
        if (state.tickerSeverityFilter === 'critical') {
            classifiedEvents = classifiedEvents.filter(function(e) { return e.severity === 'critical'; });
        } else if (state.tickerSeverityFilter === 'important') {
            classifiedEvents = classifiedEvents.filter(function(e) { return e.severity === 'critical' || e.severity === 'important'; });
        }

        // Sort: critical first, then important, then info, then low
        var severityOrder = { critical: 0, important: 1, info: 2, low: 3 };
        classifiedEvents.sort(function(a, b) {
            return severityOrder[a.severity] - severityOrder[b.severity];
        });

        // Group heartbeat events if collapsing is enabled
        var heartbeatEvents = [];
        var otherEvents = [];

        if (state.tickerCollapseHeartbeat) {
            classifiedEvents.forEach(function(event) {
                if (event.severity === 'low') {
                    heartbeatEvents.push(event);
                } else {
                    otherEvents.push(event);
                }
            });
        } else {
            otherEvents = classifiedEvents;
        }

        // Render other events first
        otherEvents.forEach(function(event) {
            var item = document.createElement('div');
            item.className = 'ticker-item ticker-item-' + event.severity;

            // DEV-COMHU-0202: Add status-based class for deploy events
            if (event.topic && event.topic.includes('.success')) {
                item.classList.add('ticker-item-success');
            } else if (event.topic && (event.topic.includes('.failed') || event.topic.includes('.blocked'))) {
                item.classList.add('ticker-item-error');
            }

            // Severity indicator
            var severityDot = document.createElement('span');
            severityDot.className = 'ticker-severity-dot ticker-severity-' + event.severity;
            item.appendChild(severityDot);

            var timestamp = document.createElement('div');
            timestamp.className = 'ticker-timestamp';
            timestamp.textContent = event.timestamp;
            item.appendChild(timestamp);

            // VTID-0526-D: Show task_stage badge if present
            if (event.task_stage) {
                var stageBadge = document.createElement('div');
                stageBadge.className = 'ticker-stage ticker-stage-' + event.task_stage.toLowerCase();
                stageBadge.textContent = event.task_stage.charAt(0);
                stageBadge.title = event.task_stage;
                item.appendChild(stageBadge);
            }

            // DEV-COMHU-0202: Show VTID badge for deploy/governance events
            if (event.vtid) {
                var vtidBadge = document.createElement('div');
                vtidBadge.className = 'ticker-vtid';
                vtidBadge.textContent = event.vtid;
                vtidBadge.title = 'VTID: ' + event.vtid;
                item.appendChild(vtidBadge);
            }

            // DEV-COMHU-0202: Show SWV badge if present
            if (event.swv) {
                var swvBadge = document.createElement('div');
                swvBadge.className = 'ticker-swv';
                swvBadge.textContent = event.swv;
                swvBadge.title = 'SWV: ' + event.swv;
                item.appendChild(swvBadge);
            }

            var content = document.createElement('div');
            content.className = 'ticker-content';
            content.textContent = event.content;
            item.appendChild(content);

            // DEV-COMHU-0202: Show topic for deploy events instead of generic type
            var typeLabel = event.topic && event.topic.startsWith('deploy.') ? event.topic : event.type;
            var type = document.createElement('div');
            type.className = 'ticker-type ticker-type-' + event.type;
            type.textContent = typeLabel;
            item.appendChild(type);

            eventsList.appendChild(item);
        });

        // Render collapsed heartbeat section
        if (state.tickerCollapseHeartbeat && heartbeatEvents.length > 0) {
            var heartbeatSection = document.createElement('div');
            heartbeatSection.className = 'ticker-heartbeat-collapsed';

            var heartbeatHeader = document.createElement('div');
            heartbeatHeader.className = 'ticker-heartbeat-header';
            heartbeatHeader.innerHTML = '<span class="ticker-severity-dot ticker-severity-low"></span> Heartbeat/Health events (' + heartbeatEvents.length + ')';
            heartbeatHeader.onclick = function() {
                heartbeatSection.classList.toggle('expanded');
            };
            heartbeatSection.appendChild(heartbeatHeader);

            var heartbeatList = document.createElement('div');
            heartbeatList.className = 'ticker-heartbeat-list';

            heartbeatEvents.slice(0, 10).forEach(function(event) {
                var item = document.createElement('div');
                item.className = 'ticker-item ticker-item-low ticker-item-mini';
                item.innerHTML = '<span class="ticker-timestamp">' + event.timestamp + '</span> ' + event.content;
                heartbeatList.appendChild(item);
            });

            if (heartbeatEvents.length > 10) {
                var moreNote = document.createElement('div');
                moreNote.className = 'ticker-more-note';
                moreNote.textContent = '... and ' + (heartbeatEvents.length - 10) + ' more heartbeat events';
                heartbeatList.appendChild(moreNote);
            }

            heartbeatSection.appendChild(heartbeatList);
            eventsList.appendChild(heartbeatSection);
        }
    }

    container.appendChild(eventsList);

    return container;
}

/**
 * VTID-0524: Renders the operator history tab showing deployment history
 * with VTID + SWV + status + timestamp
 */
function renderOperatorHistory() {
    const container = document.createElement('div');
    container.className = 'history-container';

    // Header with refresh button
    const header = document.createElement('div');
    header.className = 'history-header';

    const title = document.createElement('span');
    title.textContent = 'Deployment History';
    header.appendChild(title);

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn history-refresh-btn';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.onclick = async () => {
        state.historyLoading = true;
        state.historyError = null;
        renderApp();
        try {
            state.versionHistory = await fetchDeploymentHistory();
            state.historyError = null;
        } catch (error) {
            state.historyError = error.message;
        } finally {
            state.historyLoading = false;
            renderApp();
        }
    };
    header.appendChild(refreshBtn);

    container.appendChild(header);

    // Content
    const content = document.createElement('div');
    content.className = 'history-content';

    if (state.historyLoading) {
        content.innerHTML = '<div class="history-loading">Loading deployment history...</div>';
    } else if (state.historyError) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'history-error';
        errorDiv.textContent = 'Error: ' + state.historyError;
        content.appendChild(errorDiv);
    } else if (!state.versionHistory || state.versionHistory.length === 0) {
        content.innerHTML = '<div class="history-empty">No deployments yet. Click Refresh to load.</div>';
        // Auto-fetch on first open if empty
        if (!state.historyLoading) {
            setTimeout(async () => {
                state.historyLoading = true;
                renderApp();
                try {
                    state.versionHistory = await fetchDeploymentHistory();
                } catch (error) {
                    state.historyError = error.message;
                } finally {
                    state.historyLoading = false;
                    renderApp();
                }
            }, 100);
        }
    } else {
        // VTID-0524 + VTID-0600: Render deployment history table with human-readable meaning
        const table = document.createElement('table');
        table.className = 'history-table';

        const thead = document.createElement('thead');
        const theadTr = document.createElement('tr');

        // VTID-0600: Added 'Summary', 'Triggered By', and 'Meaning' columns
        ['VTID', 'Service', 'SWV', 'Timestamp', 'Status', 'Summary', 'Triggered By'].forEach(function(headerText) {
            const th = document.createElement('th');
            th.textContent = headerText;
            theadTr.appendChild(th);
        });
        thead.appendChild(theadTr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        state.versionHistory.forEach(function(deploy) {
            const tr = document.createElement('tr');

            // VTID column
            const vtidTd = document.createElement('td');
            vtidTd.className = 'history-vtid';
            vtidTd.textContent = deploy.vtid || '-';
            tr.appendChild(vtidTd);

            // Service column
            const serviceTd = document.createElement('td');
            serviceTd.className = 'history-service';
            serviceTd.textContent = deploy.service || '-';
            tr.appendChild(serviceTd);

            // SWV column
            const swvTd = document.createElement('td');
            swvTd.className = 'history-swv';
            swvTd.textContent = deploy.swv || '-';
            tr.appendChild(swvTd);

            // Timestamp column
            const timeTd = document.createElement('td');
            timeTd.className = 'history-time';
            timeTd.textContent = deploy.createdAt ? new Date(deploy.createdAt).toLocaleString() : '-';
            tr.appendChild(timeTd);

            // Status column with color coding
            const statusTd = document.createElement('td');
            statusTd.className = 'history-status';
            const statusBadge = document.createElement('span');
            statusBadge.className = 'history-status-badge';
            if (deploy.status === 'success') {
                statusBadge.className += ' history-status-success';
            } else if (deploy.status === 'failure') {
                statusBadge.className += ' history-status-failed';
            }
            statusBadge.textContent = deploy.status || 'unknown';
            statusTd.appendChild(statusBadge);
            tr.appendChild(statusTd);

            // VTID-0600: Event Summary column (derived from VTID and service)
            const summaryTd = document.createElement('td');
            summaryTd.className = 'history-summary';
            var summary = generateDeploySummary(deploy);
            summaryTd.textContent = summary;
            tr.appendChild(summaryTd);

            // VTID-0600: Triggered By column
            const triggeredByTd = document.createElement('td');
            triggeredByTd.className = 'history-triggered-by';
            var triggeredBy = deploy.initiator || 'user';
            var triggeredByBadge = document.createElement('span');
            triggeredByBadge.className = 'history-trigger-badge history-trigger-' + triggeredBy.toLowerCase();
            triggeredByBadge.textContent = triggeredBy === 'agent' ? 'CI/CD' : 'User';
            triggeredByTd.appendChild(triggeredByBadge);
            tr.appendChild(triggeredByTd);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        content.appendChild(table);
    }

    container.appendChild(content);
    return container;
}

// --- Publish Modal (VTID-0517) ---

/**
 * VTID-0523-A: Get the selected version object from version history
 * Returns the full version object or null if no version selected
 */
function getSelectedVersion() {
    if (!state.selectedVersionId || !state.versionHistory) {
        return null;
    }
    return state.versionHistory.find(v => v.id === state.selectedVersionId) || null;
}

/**
 * VTID-0523-A: Get the most recent version as default selection
 * Returns the first (most recent) version from history or null
 */
function getMostRecentVersion() {
    if (!state.versionHistory || state.versionHistory.length === 0) {
        return null;
    }
    return state.versionHistory[0];
}

/**
 * VTID-0523-B: Full Publish Confirmation Sheet
 * Unified UX with inline version selection - no separate dropdown needed
 */
function renderPublishModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            console.log('[VTID-0523-B] Publish cancelled: clicked overlay');
            state.showPublishModal = false;
            renderApp();
        }
    };

    const modal = document.createElement('div');
    modal.className = 'modal publish-modal';
    modal.style.cssText = 'max-width: 520px; width: 90%;';

    // Get current selection
    const selectedVersion = getSelectedVersion();
    const hasVersions = state.versionHistory && state.versionHistory.length > 0;

    // === HEADER ===
    const header = document.createElement('div');
    header.className = 'modal-header';
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.1);';

    const title = document.createElement('span');
    title.textContent = 'Publish to Environment';
    title.style.cssText = 'font-size: 18px; font-weight: 600;';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = 'background: none; border: none; color: #888; font-size: 28px; cursor: pointer; padding: 0; line-height: 1;';
    closeBtn.onclick = () => {
        console.log('[VTID-0523-B] Publish cancelled: clicked close');
        state.showPublishModal = false;
        renderApp();
    };
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // === BODY ===
    const body = document.createElement('div');
    body.className = 'modal-body';
    body.style.cssText = 'padding: 20px;';

    // Environment Info Section
    const envSection = document.createElement('div');
    envSection.style.cssText = 'margin-bottom: 20px; padding: 14px; background: rgba(255,255,255,0.03); border-radius: 8px; font-size: 13px;';
    envSection.innerHTML = `
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span style="color: #888;">Environment:</span>
            <span style="color: #4ade80; font-weight: 500;">vitana-dev (us-central1)</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span style="color: #888;">Service:</span>
            <span style="color: #fff;">gateway</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
            <span style="color: #888;">Domain:</span>
            <span style="color: #60a5fa;">gateway-*.run.app</span>
        </div>
    `;
    body.appendChild(envSection);

    // Version Selector Section
    const versionSection = document.createElement('div');
    versionSection.style.cssText = 'margin-bottom: 20px;';

    const versionLabel = document.createElement('div');
    versionLabel.style.cssText = 'color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px;';
    versionLabel.textContent = 'Version to Deploy';
    versionSection.appendChild(versionLabel);

    // Custom dark-themed dropdown
    const dropdownContainer = document.createElement('div');
    dropdownContainer.style.cssText = 'position: relative;';

    const dropdownButton = document.createElement('button');
    dropdownButton.type = 'button';
    dropdownButton.style.cssText = `
        width: 100%;
        padding: 14px 16px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 8px;
        color: #fff;
        font-size: 14px;
        cursor: pointer;
        text-align: left;
        display: flex;
        justify-content: space-between;
        align-items: center;
    `;

    const buttonText = document.createElement('span');
    if (!hasVersions) {
        buttonText.textContent = 'Loading versions...';
        buttonText.style.color = '#888';
    } else if (selectedVersion) {
        const commitShort = selectedVersion.commit ? selectedVersion.commit.substring(0, 8) : 'unknown';
        buttonText.textContent = `${selectedVersion.swv} — ${selectedVersion.service} — ${commitShort}`;
        buttonText.style.color = '#4ade80';
    } else {
        buttonText.textContent = '— Select a version to deploy —';
        buttonText.style.color = '#888';
    }
    dropdownButton.appendChild(buttonText);

    const arrow = document.createElement('span');
    arrow.textContent = '▼';
    arrow.style.cssText = 'color: #888; font-size: 10px; transition: transform 0.2s;';
    dropdownButton.appendChild(arrow);

    const dropdownList = document.createElement('div');
    dropdownList.id = 'version-dropdown-list';
    dropdownList.style.cssText = `
        display: none;
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        background: #1e293b;
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 8px;
        margin-top: 4px;
        max-height: 280px;
        overflow-y: auto;
        z-index: 1000;
        box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    `;

    if (hasVersions) {
        state.versionHistory.forEach(v => {
            const item = document.createElement('div');
            const commitShort = v.commit ? v.commit.substring(0, 8) : 'unknown';
            const statusIcon = v.status === 'success' ? '✓' : '⚠';
            const isSelected = selectedVersion && v.id === selectedVersion.id;

            item.style.cssText = `
                padding: 12px 16px;
                cursor: pointer;
                border-bottom: 1px solid rgba(255,255,255,0.05);
                color: ${isSelected ? '#4ade80' : '#fff'};
                background: ${isSelected ? 'rgba(74,222,128,0.1)' : 'transparent'};
            `;
            item.innerHTML = `
                <div style="font-weight: 500;">${v.swv} — ${v.service} ${statusIcon}</div>
                <div style="font-size: 12px; color: #888; margin-top: 4px;">Commit: ${commitShort} | ${v.vtid || 'N/A'}</div>
            `;

            item.onmouseenter = () => { item.style.background = isSelected ? 'rgba(74,222,128,0.15)' : 'rgba(255,255,255,0.08)'; };
            item.onmouseleave = () => { item.style.background = isSelected ? 'rgba(74,222,128,0.1)' : 'transparent'; };

            item.onclick = (e) => {
                e.stopPropagation();
                state.selectedVersionId = v.id;
                renderApp();
            };

            dropdownList.appendChild(item);
        });
    }

    dropdownButton.onclick = (e) => {
        e.stopPropagation();
        const isOpen = dropdownList.style.display === 'block';
        dropdownList.style.display = isOpen ? 'none' : 'block';
        arrow.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
    };

    // Close dropdown when clicking outside
    overlay.addEventListener('click', (e) => {
        if (!dropdownContainer.contains(e.target)) {
            dropdownList.style.display = 'none';
            arrow.style.transform = 'rotate(0deg)';
        }
    });

    dropdownContainer.appendChild(dropdownButton);
    dropdownContainer.appendChild(dropdownList);
    versionSection.appendChild(dropdownContainer);
    body.appendChild(versionSection);

    // Version Details Panel (shows when version selected)
    if (selectedVersion) {
        const detailsPanel = document.createElement('div');
        detailsPanel.style.cssText = 'background: rgba(74, 222, 128, 0.08); border: 1px solid rgba(74, 222, 128, 0.25); border-radius: 8px; padding: 16px; margin-bottom: 16px; font-family: ui-monospace, monospace; font-size: 13px;';

        const commitFull = selectedVersion.commit || 'unknown';
        const commitShort = commitFull.length > 8 ? commitFull.substring(0, 8) : commitFull;
        const statusColor = selectedVersion.status === 'success' ? '#4ade80' : '#fbbf24';

        detailsPanel.innerHTML = `
            <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                <span style="color: #888;">Version:</span>
                <span style="color: #4ade80; font-weight: 600; font-size: 14px;">${selectedVersion.swv}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                <span style="color: #888;">Commit:</span>
                <span style="color: #fbbf24;" title="${commitFull}">${commitShort}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                <span style="color: #888;">VTID:</span>
                <span style="color: #60a5fa;">${selectedVersion.vtid || 'N/A'}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
                <span style="color: #888;">Build Status:</span>
                <span style="color: ${statusColor};">${(selectedVersion.status || 'unknown').charAt(0).toUpperCase() + (selectedVersion.status || 'unknown').slice(1)}</span>
            </div>
        `;
        body.appendChild(detailsPanel);

        // Warning if this is the most recent (possibly already live)
        const isLatest = state.versionHistory[0] && state.versionHistory[0].id === selectedVersion.id;
        if (isLatest) {
            const warningBox = document.createElement('div');
            warningBox.style.cssText = 'background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.25); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; font-size: 13px; color: #fbbf24;';
            warningBox.innerHTML = `<strong>Note:</strong> ${selectedVersion.swv} is the latest version. Re-deploying will trigger a fresh deployment.`;
            body.appendChild(warningBox);
        }
    } else if (hasVersions) {
        // No version selected - show instruction
        const instructionBox = document.createElement('div');
        instructionBox.style.cssText = 'background: rgba(96, 165, 250, 0.08); border: 1px solid rgba(96, 165, 250, 0.25); border-radius: 8px; padding: 20px; text-align: center; color: #60a5fa;';
        instructionBox.innerHTML = `
            <div style="font-size: 32px; margin-bottom: 10px;">☝️</div>
            <div style="font-size: 14px;">Select a version above to see details</div>
        `;
        body.appendChild(instructionBox);
    }

    // VTID-0541 D4: CI/CD Health Warning with proper distinction
    // - 'degraded': Runtime is broken - show error warning
    // - 'ok_governance_limited': Runtime OK but governance features unavailable - show info warning
    // - 'ok': All good - no warning
    if (state.cicdHealth) {
        const healthStatus = state.cicdHealth.status;
        const runtimeHealth = state.cicdHealth.health?.runtime_deploy;

        if (healthStatus === 'degraded' || runtimeHealth === 'degraded') {
            // Runtime actually broken - show red error warning
            const cicdWarning = document.createElement('div');
            cicdWarning.style.cssText = 'background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; font-size: 13px; color: #f87171;';
            cicdWarning.innerHTML = `<strong>⚠ CI/CD Degraded:</strong> Runtime deploy health is not available. Deployment may fail.`;
            body.appendChild(cicdWarning);
        } else if (healthStatus === 'ok_governance_limited') {
            // Governance limited but runtime OK - show yellow informational warning
            const govWarning = document.createElement('div');
            govWarning.style.cssText = 'background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.25); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; font-size: 13px; color: #fbbf24;';
            const note = state.cicdHealth.notes?.governance_limited || 'GitHub integration unavailable - some governance features are limited';
            govWarning.innerHTML = `<strong>ℹ Governance Limited:</strong> ${note}. Deploy will proceed normally.`;
            body.appendChild(govWarning);
        }
    }

    modal.appendChild(body);

    // === FOOTER ===
    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    footer.style.cssText = 'display: flex; justify-content: flex-end; gap: 12px; padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.1);';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding: 12px 24px; background: rgba(255,255,255,0.1); border: none; border-radius: 6px; color: #fff; cursor: pointer;';
    cancelBtn.onclick = () => {
        console.log('[VTID-0523-B] Publish cancelled: clicked cancel button');
        state.showPublishModal = false;
        renderApp();
    };
    footer.appendChild(cancelBtn);

    const deployBtn = document.createElement('button');
    deployBtn.className = 'btn btn-primary';

    if (selectedVersion) {
        deployBtn.textContent = `Deploy ${selectedVersion.swv}`;
        deployBtn.style.cssText = 'padding: 12px 28px; background: #4ade80; border: none; border-radius: 6px; color: #000; font-weight: 600; cursor: pointer;';
    } else {
        deployBtn.textContent = 'Deploy';
        deployBtn.disabled = true;
        deployBtn.style.cssText = 'padding: 12px 28px; background: #4ade80; border: none; border-radius: 6px; color: #000; font-weight: 600; opacity: 0.4; cursor: not-allowed;';
        deployBtn.title = 'Select a version first';
    }

    deployBtn.onclick = async () => {
        if (!selectedVersion) {
            showToast('Please select a version before deploying', 'error');
            return;
        }

        console.log('[VTID-0523-B] Deploy confirmed:', selectedVersion);
        deployBtn.disabled = true;
        deployBtn.textContent = 'Deploying...';
        deployBtn.style.opacity = '0.7';

        try {
            const payload = {
                vtid: selectedVersion.vtid || ('VTID-DEPLOY-' + Date.now()),
                swv: selectedVersion.swv,
                service: selectedVersion.service || 'gateway',
                environment: 'dev',
                commit: selectedVersion.commit,
                actor: 'operator-ui'
            };

            const response = await fetch('/api/v1/operator/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();

            // VTID-0407: Check for governance blocked response
            if (result.blocked === true) {
                console.log('[VTID-0407] Deploy blocked by governance:', result);
                state.showPublishModal = false;
                state.showGovernanceBlockedModal = true;
                state.governanceBlockedData = {
                    level: result.level || 'L1',
                    violations: result.violations || [],
                    service: payload.service,
                    vtid: payload.vtid,
                    swv: selectedVersion.swv
                };

                // Add to ticker with governance blocked event
                state.tickerEvents.unshift({
                    id: Date.now(),
                    timestamp: new Date().toLocaleTimeString(),
                    type: 'governance',
                    content: 'governance.deploy.blocked: ' + selectedVersion.swv + ' deployment stopped'
                });

                renderApp();
                return;
            }

            if (!result.ok) {
                throw new Error(result.error || 'Deploy failed');
            }

            console.log('[VTID-0523-B] Deploy queued:', result);
            state.showPublishModal = false;

            const commitShort = selectedVersion.commit ? selectedVersion.commit.substring(0, 7) : '';
            showToast('Deployment started: ' + selectedVersion.swv + ' (' + commitShort + ')', 'success');

            // Add to ticker with full version details and governance allowed event
            state.tickerEvents.unshift({
                id: Date.now(),
                timestamp: new Date().toLocaleTimeString(),
                type: 'governance',
                content: 'governance.deploy.allowed: ' + selectedVersion.swv + ' deployment started'
            });

            renderApp();

        } catch (error) {
            console.error('[VTID-0523-B] Deploy error:', error);
            showToast('Deploy failed: ' + error.message, 'error');
            deployBtn.disabled = false;
            deployBtn.textContent = 'Deploy ' + selectedVersion.swv;
            deployBtn.style.opacity = '1';
        }
    };

    footer.appendChild(deployBtn);
    modal.appendChild(footer);

    overlay.appendChild(modal);
    return overlay;
}

// --- VTID-0407: Governance Blocked Modal ---

/**
 * VTID-0407: Render the Governance Blocked modal
 * Shown when deployment is blocked due to L1/L2 violations
 */
function renderGovernanceBlockedModal() {
    var data = state.governanceBlockedData;
    if (!data) return null;

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = function(e) {
        if (e.target === overlay) {
            state.showGovernanceBlockedModal = false;
            state.governanceBlockedData = null;
            renderApp();
        }
    };

    var modal = document.createElement('div');
    modal.className = 'modal governance-blocked-modal';
    modal.style.cssText = 'max-width: 560px; width: 90%;';

    // === HEADER ===
    var header = document.createElement('div');
    header.className = 'modal-header governance-blocked-header';
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid rgba(239,68,68,0.3); background: rgba(239,68,68,0.08);';

    var titleRow = document.createElement('div');
    titleRow.style.cssText = 'display: flex; align-items: center; gap: 12px;';

    var iconSpan = document.createElement('span');
    iconSpan.style.cssText = 'font-size: 24px;';
    iconSpan.textContent = '\u26D4'; // No entry unicode
    titleRow.appendChild(iconSpan);

    var title = document.createElement('span');
    title.textContent = 'Deployment Blocked by Governance';
    title.style.cssText = 'font-size: 18px; font-weight: 600; color: #f87171;';
    titleRow.appendChild(title);

    header.appendChild(titleRow);

    var closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = 'background: none; border: none; color: #888; font-size: 28px; cursor: pointer; padding: 0; line-height: 1;';
    closeBtn.onclick = function() {
        state.showGovernanceBlockedModal = false;
        state.governanceBlockedData = null;
        renderApp();
    };
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // === BODY ===
    var body = document.createElement('div');
    body.className = 'modal-body';
    body.style.cssText = 'padding: 20px;';

    // Message section
    var messageSection = document.createElement('div');
    messageSection.style.cssText = 'margin-bottom: 20px; padding: 14px; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.25); border-radius: 8px;';

    var messageText = document.createElement('p');
    messageText.style.cssText = 'margin: 0; color: #f8fafc; font-size: 14px; line-height: 1.5;';
    messageText.textContent = 'Your deployment was stopped because one or more ' + data.level + ' rules were violated. Please address the violations below before attempting to deploy again.';
    messageSection.appendChild(messageText);

    body.appendChild(messageSection);

    // Deploy info
    var infoSection = document.createElement('div');
    infoSection.style.cssText = 'margin-bottom: 20px; padding: 12px; background: rgba(255,255,255,0.03); border-radius: 8px; font-size: 13px;';
    infoSection.innerHTML = '<div style="display: flex; justify-content: space-between; margin-bottom: 6px;"><span style="color: #888;">Version:</span><span style="color: #4ade80;">' + (data.swv || 'N/A') + '</span></div>' +
        '<div style="display: flex; justify-content: space-between; margin-bottom: 6px;"><span style="color: #888;">Service:</span><span style="color: #fff;">' + (data.service || 'gateway') + '</span></div>' +
        '<div style="display: flex; justify-content: space-between;"><span style="color: #888;">VTID:</span><span style="color: #60a5fa;">' + (data.vtid || 'N/A') + '</span></div>';
    body.appendChild(infoSection);

    // Violations label
    var violationsLabel = document.createElement('div');
    violationsLabel.style.cssText = 'color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px;';
    violationsLabel.textContent = 'Violated Rules (' + (data.violations ? data.violations.length : 0) + ')';
    body.appendChild(violationsLabel);

    // Violations list
    var violationsList = document.createElement('div');
    violationsList.style.cssText = 'display: flex; flex-direction: column; gap: 10px; max-height: 240px; overflow-y: auto;';

    if (data.violations && data.violations.length > 0) {
        data.violations.forEach(function(violation) {
            var violationCard = document.createElement('div');
            violationCard.className = 'governance-violation-card';
            violationCard.style.cssText = 'padding: 12px 14px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; cursor: pointer; transition: all 0.2s;';

            // Make card clickable to open rule drawer
            violationCard.onclick = function() {
                // Set selected rule and navigate to governance rules
                state.selectedGovernanceRule = {
                    id: violation.rule_id,
                    level: violation.level,
                    title: violation.message
                };
                state.showGovernanceBlockedModal = false;
                state.governanceBlockedData = null;
                // Navigate to governance rules tab
                state.currentModuleKey = 'governance';
                state.currentTab = 'rules';
                renderApp();
            };

            violationCard.onmouseenter = function() {
                violationCard.style.background = 'rgba(255,255,255,0.06)';
                violationCard.style.borderColor = 'rgba(239,68,68,0.3)';
            };
            violationCard.onmouseleave = function() {
                violationCard.style.background = 'rgba(255,255,255,0.03)';
                violationCard.style.borderColor = 'rgba(255,255,255,0.1)';
            };

            var cardHeader = document.createElement('div');
            cardHeader.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 8px;';

            // Rule ID chip
            var ruleChip = document.createElement('span');
            ruleChip.className = 'governance-rule-chip';
            ruleChip.style.cssText = 'padding: 4px 8px; background: rgba(96,165,250,0.15); border: 1px solid rgba(96,165,250,0.3); border-radius: 4px; font-size: 12px; font-weight: 600; color: #60a5fa; font-family: ui-monospace, monospace;';
            ruleChip.textContent = violation.rule_id || 'UNKNOWN';
            cardHeader.appendChild(ruleChip);

            // Level indicator
            var levelBadge = document.createElement('span');
            var levelColor = violation.level === 'L1' ? '#ef4444' : violation.level === 'L2' ? '#f59e0b' : '#60a5fa';
            levelBadge.style.cssText = 'padding: 2px 6px; background: ' + levelColor + '22; border: 1px solid ' + levelColor + '44; border-radius: 4px; font-size: 11px; font-weight: 600; color: ' + levelColor + ';';
            levelBadge.textContent = violation.level || 'L1';
            cardHeader.appendChild(levelBadge);

            violationCard.appendChild(cardHeader);

            // Message
            var messageP = document.createElement('p');
            messageP.style.cssText = 'margin: 0; color: #94a3b8; font-size: 13px; line-height: 1.4;';
            messageP.textContent = violation.message || 'Rule violation detected';
            violationCard.appendChild(messageP);

            // Hint to click
            var hintText = document.createElement('div');
            hintText.style.cssText = 'margin-top: 8px; font-size: 11px; color: #64748b;';
            hintText.textContent = 'Click to view rule details \u2192';
            violationCard.appendChild(hintText);

            violationsList.appendChild(violationCard);
        });
    } else {
        var noViolations = document.createElement('div');
        noViolations.style.cssText = 'padding: 20px; text-align: center; color: #888;';
        noViolations.textContent = 'No violation details available';
        violationsList.appendChild(noViolations);
    }

    body.appendChild(violationsList);
    modal.appendChild(body);

    // === FOOTER ===
    var footer = document.createElement('div');
    footer.className = 'modal-footer';
    footer.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.1);';

    var helpText = document.createElement('span');
    helpText.style.cssText = 'font-size: 12px; color: #64748b;';
    helpText.textContent = 'Contact admin to request rule exceptions';
    footer.appendChild(helpText);

    var dismissBtn = document.createElement('button');
    dismissBtn.className = 'btn';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.style.cssText = 'padding: 10px 20px; background: rgba(255,255,255,0.1); border: none; border-radius: 6px; color: #fff; cursor: pointer;';
    dismissBtn.onclick = function() {
        state.showGovernanceBlockedModal = false;
        state.governanceBlockedData = null;
        renderApp();
    };
    footer.appendChild(dismissBtn);

    modal.appendChild(footer);
    overlay.appendChild(modal);
    return overlay;
}

// --- Bundle Fingerprint (VTID-0529-B) ---
// Hard fingerprint that proves which bundle is actually being served
// Banner at top + footer label at bottom-right

function renderBundleFingerprintBanner() {
    const banner = document.createElement('div');
    banner.className = 'bundle-fingerprint-banner';
    banner.textContent = 'VTID-0529-B – LIVE BUNDLE';
    return banner;
}

function renderBundleFingerprintFooter() {
    const footer = document.createElement('div');
    footer.className = 'bundle-fingerprint-footer';
    footer.textContent = 'Bundle: VTID-0529-B';
    return footer;
}

// --- Toast Notification Container (VTID-0517) ---

function renderToastContainer() {
    const container = document.createElement('div');
    container.className = 'toast-container';

    state.toasts.forEach(toast => {
        const toastEl = document.createElement('div');
        toastEl.className = 'toast toast--' + toast.type;

        const message = document.createElement('span');
        message.className = 'toast__message';
        message.textContent = toast.message;
        toastEl.appendChild(message);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast__close';
        closeBtn.innerHTML = '&times;';
        closeBtn.onclick = () => {
            state.toasts = state.toasts.filter(t => t.id !== toast.id);
            renderApp();
        };
        toastEl.appendChild(closeBtn);

        container.appendChild(toastEl);
    });

    return container;
}

// --- VTID-0509: Operator Console API Functions ---

/**
 * Toggle heartbeat session between Live and Standby
 */
async function toggleHeartbeatSession() {
    const newStatus = state.operatorHeartbeatActive ? 'standby' : 'live';
    console.log(`[Operator] Toggling heartbeat to: ${newStatus}`);

    try {
        const response = await fetch('/api/v1/operator/heartbeat/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });

        if (!response.ok) {
            throw new Error(`Session update failed: ${response.status}`);
        }

        const result = await response.json();
        console.log('[Operator] Session updated:', result);

        state.operatorHeartbeatActive = newStatus === 'live';

        if (state.operatorHeartbeatActive) {
            // Fetch heartbeat snapshot
            await fetchHeartbeatSnapshot();
            // Start SSE stream
            startOperatorSse();
            // Open operator console on ticker tab
            state.operatorActiveTab = 'ticker';
            state.isOperatorOpen = true;
        } else {
            // Stop SSE stream
            stopOperatorSse();
        }

        renderApp();

    } catch (error) {
        console.error('[Operator] Session toggle error:', error);
        alert('Failed to update heartbeat session: ' + error.message);
    }
}

/**
 * Fetch heartbeat snapshot from API
 */
async function fetchHeartbeatSnapshot() {
    console.log('[Operator] Fetching heartbeat snapshot...');
    try {
        const response = await fetch('/api/v1/operator/heartbeat');
        if (!response.ok) {
            throw new Error(`Heartbeat fetch failed: ${response.status}`);
        }

        const snapshot = await response.json();
        console.log('[Operator] Heartbeat snapshot:', snapshot);

        state.operatorHeartbeatSnapshot = snapshot;

        // Add snapshot events to ticker (backend returns 'recent_events', not 'events')
        // Backend returns newest first, we want newest at top (index 0)
        const events = snapshot.recent_events || snapshot.events || [];
        if (events.length > 0) {
            // Clear existing ticker events and add new ones (newest first)
            state.tickerEvents = events.map(event => ({
                id: Date.now() + Math.random(),
                timestamp: new Date(event.created_at).toLocaleTimeString(),
                type: event.type.split('.')[0] || 'info',
                content: event.summary
            }));
        }

    } catch (error) {
        console.error('[Operator] Heartbeat snapshot error:', error);
    }
}

/**
 * Start SSE stream for operator channel
 */
function startOperatorSse() {
    if (state.operatorSseSource) {
        console.log('[Operator] SSE already connected');
        return;
    }

    console.log('[Operator] Starting SSE stream...');
    const sseUrl = '/api/v1/events/stream?channel=operator';
    const eventSource = new EventSource(sseUrl);

    eventSource.onopen = () => {
        console.log('[Operator] SSE connected');
    };

    eventSource.addEventListener('connected', (e) => {
        console.log('[Operator] SSE connection confirmed:', e.data);
    });

    eventSource.addEventListener('oasis-event', (e) => {
        try {
            const event = JSON.parse(e.data);
            console.log('[Operator] SSE event:', event);

            // DEV-COMHU-0202: Normalize event for ticker with deploy event support
            const vtid = event.vtid || (event.payload && event.payload.vtid) || null;
            const swv = event.swv || (event.payload && event.payload.swv) || null;
            const topic = event.topic || event.type || 'unknown';
            const service = event.service || (event.payload && event.payload.service) || null;
            const message = event.message || (event.payload && event.payload.message) || '';

            // Build display content with deploy event info
            let displayContent = message || topic;
            if (topic.startsWith('deploy.') && service) {
                displayContent = topic.replace('deploy.', '').replace('.', ' ').toUpperCase();
                if (message) displayContent += ': ' + message;
            }

            // Add to ticker (VTID-0526-D: include task_stage, DEV-COMHU-0202: include vtid/swv/topic)
            state.tickerEvents.unshift({
                id: event.id || Date.now(),
                timestamp: new Date(event.created_at).toLocaleTimeString(),
                type: topic.split('.')[0] || 'info',
                topic: topic,
                content: displayContent,
                vtid: vtid,
                swv: swv,
                service: service,
                status: event.status,
                task_stage: event.task_stage || (event.payload && event.payload.task_stage) || null
            });

            // DEV-COMHU-0202: Also store in global events state for VTID correlation
            state.events = state.events || [];
            state.events.unshift({
                id: event.id,
                topic: topic,
                vtid: vtid,
                swv: swv,
                service: service,
                message: message,
                status: event.status,
                createdAt: event.created_at,
                raw: event
            });
            // Cap events at 200
            if (state.events.length > 200) {
                state.events = state.events.slice(0, 200);
            }

            // VTID-0526-D: Update stage counters on new event
            if (event.task_stage && state.stageCounters[event.task_stage] !== undefined) {
                state.stageCounters[event.task_stage]++;
            }

            // Keep only last 100 ticker events
            if (state.tickerEvents.length > 100) {
                state.tickerEvents = state.tickerEvents.slice(0, 100);
            }

            // VTID-0526-E: Skip render when chat tab is active to prevent flickering
            // Only render if on ticker tab (where events are displayed) or not in operator console
            var shouldRender = !state.isOperatorOpen || state.operatorActiveTab === 'ticker';
            if (shouldRender) {
                renderApp();
            }
        } catch (err) {
            console.error('[Operator] SSE event parse error:', err);
        }
    });

    eventSource.onerror = (err) => {
        console.error('[Operator] SSE error:', err);
    };

    state.operatorSseSource = eventSource;
}

/**
 * Stop SSE stream
 */
function stopOperatorSse() {
    if (state.operatorSseSource) {
        console.log('[Operator] Stopping SSE stream...');
        state.operatorSseSource.close();
        state.operatorSseSource = null;
    }
}

/**
 * VTID-0526-D: Telemetry auto-refresh interval ID
 */
let telemetryAutoRefreshInterval = null;

/**
 * VTID-0526-D: Fetch telemetry snapshot with stage counters.
 * VTID-0527: Also populates telemetryEvents for task stage timelines.
 * This populates the stageCounters state and optionally the tickerEvents.
 */
async function fetchTelemetrySnapshot() {
    console.log('[VTID-0527] Fetching telemetry snapshot...');
    state.stageCountersLoading = true;

    try {
        // VTID-0527: Increased limit to 100 for more comprehensive task stage tracking
        const response = await fetch('/api/v1/telemetry/snapshot?limit=100&hours=48');
        if (!response.ok) {
            throw new Error(`Telemetry snapshot fetch failed: ${response.status}`);
        }

        const result = await response.json();
        console.log('[VTID-0527] Telemetry snapshot loaded:', result);

        // Update stage counters
        if (result.counters) {
            state.stageCounters = {
                PLANNER: result.counters.PLANNER || 0,
                WORKER: result.counters.WORKER || 0,
                VALIDATOR: result.counters.VALIDATOR || 0,
                DEPLOY: result.counters.DEPLOY || 0
            };
        }

        // VTID-0527: Store raw events for task stage timeline computation
        if (result.events && result.events.length > 0) {
            state.telemetryEvents = result.events.map(function(event) {
                return {
                    id: event.id,
                    created_at: event.created_at,
                    vtid: event.vtid,
                    kind: event.kind,
                    status: event.status,
                    title: event.title,
                    task_stage: event.task_stage || null,
                    source: event.source,
                    layer: event.layer
                };
            });
        }

        // Optionally merge events into ticker if not already populated via SSE
        if (result.events && result.events.length > 0 && state.tickerEvents.length === 0) {
            state.tickerEvents = result.events.slice(0, 20).map(function(event) {
                return {
                    id: event.id || Date.now() + Math.random(),
                    timestamp: new Date(event.created_at).toLocaleTimeString(),
                    type: (event.kind || '').split('.')[0] || 'info',
                    content: event.title || 'Event',
                    task_stage: event.task_stage || null
                };
            });
        }

        state.telemetrySnapshotError = null;
        state.lastTelemetryRefresh = new Date().toISOString();

    } catch (error) {
        console.error('[VTID-0527] Telemetry snapshot error:', error);
        state.telemetrySnapshotError = error.message;
    } finally {
        state.stageCountersLoading = false;
        renderApp();
    }
}

/**
 * VTID-0526-D: Start auto-refresh for telemetry (during active execution).
 * Polls every 3 seconds while the operator console is open.
 */
function startTelemetryAutoRefresh() {
    if (telemetryAutoRefreshInterval) {
        console.log('[VTID-0526-D] Auto-refresh already active');
        return;
    }

    console.log('[VTID-0526-D] Starting telemetry auto-refresh (3s interval)');

    telemetryAutoRefreshInterval = setInterval(function() {
        if (state.telemetryAutoRefreshEnabled && state.isOperatorOpen) {
            fetchTelemetrySnapshot();
        }
    }, 3000);
}

/**
 * VTID-0526-D: Stop auto-refresh for telemetry.
 */
function stopTelemetryAutoRefresh() {
    if (telemetryAutoRefreshInterval) {
        clearInterval(telemetryAutoRefreshInterval);
        telemetryAutoRefreshInterval = null;
        console.log('[VTID-0526-D] Telemetry auto-refresh stopped');
    }
}

/**
 * VTID-0526-B: Start Live Ticker automatically when Operator Console opens.
 * VTID-0526-D: Also loads telemetry snapshot with stage counters.
 * This function starts the heartbeat session and SSE stream without requiring
 * the user to click the Heartbeat button first.
 */
async function startOperatorLiveTicker() {
    // Skip if already active
    if (state.operatorHeartbeatActive) {
        console.log('[Operator] Live ticker already active');
        return;
    }

    console.log('[Operator] Auto-starting live ticker...');

    try {
        // Start heartbeat session
        const response = await fetch('/api/v1/operator/heartbeat/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'live' })
        });

        if (!response.ok) {
            console.warn('[Operator] Failed to start heartbeat session:', response.status);
            // Don't throw - continue to try loading events anyway
        } else {
            const result = await response.json();
            console.log('[Operator] Heartbeat session started:', result);
            state.operatorHeartbeatActive = true;
        }

        // VTID-0526-D: Fetch telemetry snapshot with stage counters (parallel with heartbeat)
        fetchTelemetrySnapshot();

        // Fetch initial heartbeat snapshot (events history)
        await fetchHeartbeatSnapshot();

        // Start SSE stream for live events
        startOperatorSse();

        // VTID-0526-D: Start auto-refresh for stage counters during active execution
        startTelemetryAutoRefresh();

        renderApp();

    } catch (error) {
        console.error('[Operator] Failed to auto-start live ticker:', error);
        // Don't alert - this is a background auto-start, not a user action
    }
}

/**
 * Fetch operator history from API
 */
async function fetchOperatorHistory() {
    console.log('[Operator] Fetching history...');
    state.historyLoading = true;
    state.historyError = null;
    renderApp();

    try {
        const response = await fetch('/api/v1/operator/history?limit=50');
        if (!response.ok) {
            throw new Error(`History fetch failed: ${response.status}`);
        }

        const result = await response.json();
        console.log('[Operator] History loaded:', result);

        state.historyEvents = result.data || [];
        state.historyError = null;

    } catch (error) {
        console.error('[Operator] History error:', error);
        state.historyError = error.message;
    } finally {
        state.historyLoading = false;
        renderApp();
    }
}

/**
 * Upload file for operator chat
 */
async function uploadOperatorFile(file, kind) {
    console.log('[Operator] Uploading file:', file.name, kind);

    try {
        const response = await fetch('/api/v1/operator/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: file.name,
                kind: kind,
                content_type: file.type || 'application/octet-stream'
            })
        });

        if (!response.ok) {
            throw new Error(`Upload failed: ${response.status}`);
        }

        const result = await response.json();
        console.log('[Operator] File uploaded:', result);

        // Add to chat attachments
        state.chatAttachments.push({
            oasis_ref: result.oasis_ref,
            kind: kind,
            name: result.name
        });

        renderApp();

    } catch (error) {
        console.error('[Operator] Upload error:', error);
        alert('Failed to upload file: ' + error.message);
    }
}

// --- VTID-0520: CI/CD Health Indicator ---

let cicdHealthPollInterval = null;

/**
 * Fetches CI/CD health status from the backend API.
 * Updates state.cicdHealth with the response.
 */
async function fetchCicdHealth() {
    console.log('[CICD] Fetching health status...');
    state.cicdHealthLoading = true;

    try {
        const response = await fetch('/api/v1/cicd/health');
        if (!response.ok) {
            throw new Error(`CICD health fetch failed: ${response.status}`);
        }

        const data = await response.json();
        console.log('[CICD] Health status:', data);

        state.cicdHealth = data;
        state.cicdHealthError = null;

    } catch (error) {
        console.error('[CICD] Health fetch error:', error);
        state.cicdHealthError = error.message;
        state.cicdHealth = null;
    } finally {
        state.cicdHealthLoading = false;
        renderApp();
    }
}

/**
 * Starts polling for CI/CD health every 10 seconds.
 */
function startCicdHealthPolling() {
    // Fetch immediately on start
    fetchCicdHealth();

    // Clear any existing interval
    if (cicdHealthPollInterval) {
        clearInterval(cicdHealthPollInterval);
    }

    // Poll every 10 seconds
    cicdHealthPollInterval = setInterval(() => {
        fetchCicdHealth();
    }, 10000);

    console.log('[CICD] Health polling started (10s interval)');
}

/**
 * Stops CI/CD health polling.
 */
function stopCicdHealthPolling() {
    if (cicdHealthPollInterval) {
        clearInterval(cicdHealthPollInterval);
        cicdHealthPollInterval = null;
        console.log('[CICD] Health polling stopped');
    }
}

/**
 * Formats the CI/CD health data for tooltip display.
 * @param {Object} healthData - The health response object
 * @returns {string} Formatted tooltip text
 */
function formatCicdHealthTooltip(healthData) {
    if (!healthData) return 'CI/CD: Loading...';

    const statusText = healthData.ok ? 'Healthy' : 'Issues Detected';
    let tooltip = `CI/CD: ${statusText}\nStatus: ${healthData.status || 'unknown'}`;

    if (healthData.capabilities) {
        tooltip += '\n\nCapabilities:';
        for (const [key, value] of Object.entries(healthData.capabilities)) {
            const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            tooltip += `\n  ${label}: ${value ? 'Yes' : 'No'}`;
        }
    }

    return tooltip;
}

// ==========================================================================
// VTID-0150-A: ORB UI & Interaction Shell (Global Assistant Overlay)
// ==========================================================================

/**
 * VTID-0150-A: SVG Icon definitions for ORB controls (CSP-compliant)
 */
const ORB_ICONS = {
    sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707"/><circle cx="12" cy="12" r="4"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
    screen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    cameraOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34m-7.72-2.06a4 4 0 1 1-5.56-5.56"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>'
};

// VTID-0150-A: ORB Idle is now rendered via renderOrbIdleElement() inside sidebar footer

/**
 * VTID-0150-A: Renders the ORB Overlay (full-screen mode)
 * @returns {HTMLElement}
 */
function renderOrbOverlay() {
    var overlay = document.createElement('div');
    overlay.className = 'orb-overlay' + (state.orb.overlayVisible ? ' orb-overlay-visible' : '');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Vitana Assistant');

    // Block background clicks
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) {
            // Close overlay when clicking backdrop
            state.orb.overlayVisible = false;
            state.orb.chatDrawerOpen = false;
            renderApp();
        }
    });

    // Large centered ORB
    var largeOrb = document.createElement('div');
    largeOrb.className = 'orb-large' + (state.orb.isThinking ? ' orb-large-thinking' : ' orb-large-idle');
    overlay.appendChild(largeOrb);

    // Status text
    var statusText = document.createElement('div');
    statusText.className = 'orb-status-text';
    statusText.textContent = state.orb.isThinking ? 'Thinking...' : 'How can I help you?';
    overlay.appendChild(statusText);

    // Control row
    var controls = document.createElement('div');
    controls.className = 'orb-controls';

    // Close button
    var closeWrapper = document.createElement('div');
    closeWrapper.className = 'orb-control-wrapper';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'orb-control-btn orb-control-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = ORB_ICONS.close;
    closeBtn.addEventListener('click', function() {
        console.log('[ORB] Closing overlay...');
        state.orb.overlayVisible = false;
        state.orb.chatDrawerOpen = false;
        renderApp();
    });
    var closeLabel = document.createElement('span');
    closeLabel.className = 'orb-control-label';
    closeLabel.textContent = 'Close';
    closeWrapper.appendChild(closeBtn);
    closeWrapper.appendChild(closeLabel);
    controls.appendChild(closeWrapper);

    // Mic toggle
    var micWrapper = document.createElement('div');
    micWrapper.className = 'orb-control-wrapper';
    var micBtn = document.createElement('button');
    micBtn.className = 'orb-control-btn' + (state.orb.micActive ? ' orb-control-active' : '');
    micBtn.setAttribute('aria-label', state.orb.micActive ? 'Mute microphone' : 'Unmute microphone');
    micBtn.setAttribute('aria-pressed', state.orb.micActive ? 'true' : 'false');
    micBtn.innerHTML = state.orb.micActive ? ORB_ICONS.mic : ORB_ICONS.micOff;
    micBtn.addEventListener('click', function() {
        console.log('[ORB] Mic toggle:', !state.orb.micActive);
        state.orb.micActive = !state.orb.micActive;
        renderApp();
    });
    var micLabel = document.createElement('span');
    micLabel.className = 'orb-control-label';
    micLabel.textContent = state.orb.micActive ? 'Mic On' : 'Mic Off';
    micWrapper.appendChild(micBtn);
    micWrapper.appendChild(micLabel);
    controls.appendChild(micWrapper);

    // Screen share toggle
    var screenWrapper = document.createElement('div');
    screenWrapper.className = 'orb-control-wrapper';
    var screenBtn = document.createElement('button');
    screenBtn.className = 'orb-control-btn' + (state.orb.screenShareActive ? ' orb-control-active' : '');
    screenBtn.setAttribute('aria-label', state.orb.screenShareActive ? 'Stop screen share' : 'Start screen share');
    screenBtn.setAttribute('aria-pressed', state.orb.screenShareActive ? 'true' : 'false');
    screenBtn.innerHTML = ORB_ICONS.screen;
    screenBtn.addEventListener('click', function() {
        console.log('[ORB] Screen share toggle:', !state.orb.screenShareActive);
        state.orb.screenShareActive = !state.orb.screenShareActive;
        renderApp();
    });
    var screenLabel = document.createElement('span');
    screenLabel.className = 'orb-control-label';
    screenLabel.textContent = state.orb.screenShareActive ? 'Sharing' : 'Screen';
    screenWrapper.appendChild(screenBtn);
    screenWrapper.appendChild(screenLabel);
    controls.appendChild(screenWrapper);

    // Camera toggle
    var cameraWrapper = document.createElement('div');
    cameraWrapper.className = 'orb-control-wrapper';
    var cameraBtn = document.createElement('button');
    cameraBtn.className = 'orb-control-btn' + (state.orb.cameraActive ? ' orb-control-active' : '');
    cameraBtn.setAttribute('aria-label', state.orb.cameraActive ? 'Turn off camera' : 'Turn on camera');
    cameraBtn.setAttribute('aria-pressed', state.orb.cameraActive ? 'true' : 'false');
    cameraBtn.innerHTML = state.orb.cameraActive ? ORB_ICONS.camera : ORB_ICONS.cameraOff;
    cameraBtn.addEventListener('click', function() {
        console.log('[ORB] Camera toggle:', !state.orb.cameraActive);
        state.orb.cameraActive = !state.orb.cameraActive;
        renderApp();
    });
    var cameraLabel = document.createElement('span');
    cameraLabel.className = 'orb-control-label';
    cameraLabel.textContent = state.orb.cameraActive ? 'Cam On' : 'Cam Off';
    cameraWrapper.appendChild(cameraBtn);
    cameraWrapper.appendChild(cameraLabel);
    controls.appendChild(cameraWrapper);

    overlay.appendChild(controls);

    // Chat button
    var chatBtn = document.createElement('button');
    chatBtn.className = 'orb-chat-btn';
    chatBtn.innerHTML = ORB_ICONS.chat + ' <span>Open Chat</span>';
    chatBtn.addEventListener('click', function() {
        console.log('[ORB] Opening chat drawer...');
        state.orb.chatDrawerOpen = true;
        renderApp();
    });
    overlay.appendChild(chatBtn);

    return overlay;
}

/**
 * VTID-0150-A: Formats timestamp for chat messages
 */
function formatOrbChatTime(isoString) {
    var date = new Date(isoString);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/**
 * VTID-0150-A: Renders the ORB Chat Drawer (right-side panel)
 * @returns {HTMLElement}
 */
function renderOrbChatDrawer() {
    var drawer = document.createElement('div');
    drawer.className = 'orb-chat-drawer' + (state.orb.chatDrawerOpen ? ' orb-chat-drawer-open' : '');
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-label', 'Vitana Chat');

    // Header
    var header = document.createElement('div');
    header.className = 'orb-chat-header';

    var titleBlock = document.createElement('div');
    titleBlock.className = 'orb-chat-title';

    var titleOrb = document.createElement('div');
    titleOrb.className = 'orb-chat-title-orb';
    titleBlock.appendChild(titleOrb);

    var titleText = document.createElement('h2');
    titleText.className = 'orb-chat-title-text';
    titleText.textContent = 'Vitana Assistant';
    titleBlock.appendChild(titleText);

    header.appendChild(titleBlock);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'orb-chat-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute('aria-label', 'Close chat');
    closeBtn.addEventListener('click', function() {
        console.log('[ORB] Closing chat drawer...');
        state.orb.chatDrawerOpen = false;
        renderApp();
    });
    header.appendChild(closeBtn);

    drawer.appendChild(header);

    // Suggestion chips placeholder
    var chipsArea = document.createElement('div');
    chipsArea.className = 'orb-suggestion-chips';
    var suggestions = ['Show my tasks', 'System status', 'Help me deploy', 'Run tests'];
    suggestions.forEach(function(suggestion) {
        var chip = document.createElement('button');
        chip.className = 'orb-suggestion-chip';
        chip.textContent = suggestion;
        chip.addEventListener('click', function() {
            // Add as user message and echo response
            orbSendMessage(suggestion);
        });
        chipsArea.appendChild(chip);
    });
    drawer.appendChild(chipsArea);

    // Messages area
    var messagesArea = document.createElement('div');
    messagesArea.className = 'orb-chat-messages';

    if (state.orb.chatMessages.length === 0) {
        // Empty state
        var emptyState = document.createElement('div');
        emptyState.className = 'orb-chat-empty';

        var emptyOrb = document.createElement('div');
        emptyOrb.className = 'orb-chat-empty-orb';
        emptyState.appendChild(emptyOrb);

        var emptyText = document.createElement('p');
        emptyText.className = 'orb-chat-empty-text';
        emptyText.textContent = 'Start a conversation';
        emptyState.appendChild(emptyText);

        var emptyHint = document.createElement('p');
        emptyHint.className = 'orb-chat-empty-hint';
        emptyHint.textContent = 'Type a message or click a suggestion above';
        emptyState.appendChild(emptyHint);

        messagesArea.appendChild(emptyState);
    } else {
        // Render messages
        state.orb.chatMessages.forEach(function(msg) {
            var msgEl = document.createElement('div');
            msgEl.className = 'orb-chat-message orb-chat-message-' + msg.role;

            var bubble = document.createElement('div');
            bubble.className = 'orb-chat-bubble';
            bubble.textContent = msg.content;
            msgEl.appendChild(bubble);

            var time = document.createElement('span');
            time.className = 'orb-chat-message-time';
            time.textContent = formatOrbChatTime(msg.timestamp);
            msgEl.appendChild(time);

            messagesArea.appendChild(msgEl);
        });
    }

    drawer.appendChild(messagesArea);

    // Input area
    var inputContainer = document.createElement('div');
    inputContainer.className = 'orb-chat-input-container';

    var input = document.createElement('textarea');
    input.className = 'orb-chat-input';
    input.placeholder = 'Type a message...';
    input.value = state.orb.chatInputValue;
    input.setAttribute('rows', '1');
    input.addEventListener('input', function(e) {
        state.orb.chatInputValue = e.target.value;
        // Auto-resize
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
    });
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            orbSendMessage(state.orb.chatInputValue);
        }
    });
    inputContainer.appendChild(input);

    var sendBtn = document.createElement('button');
    sendBtn.className = 'orb-chat-send';
    sendBtn.innerHTML = ORB_ICONS.send;
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.disabled = !state.orb.chatInputValue.trim();
    sendBtn.addEventListener('click', function() {
        orbSendMessage(state.orb.chatInputValue);
    });
    inputContainer.appendChild(sendBtn);

    drawer.appendChild(inputContainer);

    return drawer;
}

/**
 * VTID-0150-B: Scrolls the ORB chat messages to the bottom
 */
function scrollOrbChatToBottom() {
    var container = document.querySelector('.orb-chat-messages');
    if (!container) return;
    container.scrollTop = container.scrollHeight;
}

/**
 * VTID-0150-B: Sends a message to the Assistant Core API
 * @param {string} text - The message to send
 * @param {Object} context - Additional context (route, selectedId)
 * @returns {Promise<Object>} - The API response
 */
async function sendOrbMessage(text, context) {
    var res = await fetch('/api/v1/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: text,
            sessionId: state.orb.sessionId || null,
            role: 'DEV',
            tenant: 'Vitana-Dev',
            route: context.route || state.currentModuleKey || '',
            selectedId: context.selectedId || ''
        })
    });
    var data = await res.json();
    if (data.sessionId && !state.orb.sessionId) {
        state.orb.sessionId = data.sessionId;
        console.log('[ORB] Session established:', data.sessionId);
    }
    return data;
}

/**
 * VTID-0150-B: Sends a message in the ORB chat (calls Assistant Core API)
 * @param {string} message - The message to send
 */
function orbSendMessage(message) {
    if (!message || !message.trim()) return;

    console.log('[ORB] Sending message:', message);

    // Add user message immediately
    state.orb.chatMessages.push({
        id: Date.now(),
        role: 'user',
        content: message.trim(),
        timestamp: new Date().toISOString()
    });

    // Clear input and show thinking state
    state.orb.chatInputValue = '';
    state.orb.isThinking = true;
    renderApp();
    scrollOrbChatToBottom();

    // Build context from current state
    var context = {
        route: state.currentModuleKey || '',
        selectedId: state.selectedTaskId || ''
    };

    // Call Assistant Core API
    sendOrbMessage(message.trim(), context)
        .then(function(data) {
            console.log('[ORB] Response received:', data.ok ? 'success' : 'error');

            // Add assistant response
            state.orb.chatMessages.push({
                id: Date.now() + 1,
                role: 'assistant',
                content: data.reply || 'I could not generate a response.',
                timestamp: new Date().toISOString(),
                meta: data.meta
            });
            state.orb.isThinking = false;
            renderApp();
            scrollOrbChatToBottom();
        })
        .catch(function(error) {
            console.error('[ORB] API error:', error);

            // Add error message
            state.orb.chatMessages.push({
                id: Date.now() + 1,
                role: 'assistant',
                content: 'I encountered an error while processing your request. Please try again.',
                timestamp: new Date().toISOString()
            });
            state.orb.isThinking = false;
            renderApp();
            scrollOrbChatToBottom();
        });
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
    console.log('App v4 starting...');
    try {
        // Init Router
        const route = getRouteFromPath(window.location.pathname);
        state.currentModuleKey = route.section;
        state.currentTab = route.tab;

        // If current path is not valid or is root, replace with calculated path
        const section = NAVIGATION_CONFIG.find(s => s.section === route.section);
        const tab = section ? section.tabs.find(t => t.key === route.tab) : null;
        if (tab && window.location.pathname !== tab.path) {
            history.replaceState(null, '', tab.path);
        }

        renderApp();
        fetchTasks();

        // VTID-0527: Fetch telemetry snapshot for task stage timelines
        fetchTelemetrySnapshot();

        // VTID-0520: Start CI/CD health polling
        startCicdHealthPolling();
    } catch (e) {
        console.error('Critical Render Error:', e);
        document.body.innerHTML = `<div class="critical-error"><h1>Critical Error</h1><pre>${e.stack}</pre></div>`;
    }
});
