// Vitana Dev Frontend Spec v2 Implementation - Task 3

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

    // VTID-0509/VTID-0523: Operator Console State
    operatorHeartbeatActive: false,
    operatorSseSource: null,
    operatorHeartbeatSnapshot: null,

    // VTID-0523: Heartbeat tri-state model ('off' | 'live' | 'degraded')
    heartbeatState: 'off',
    heartbeatRetryCount: 0,
    heartbeatMaxRetries: 3,

    // Operator Chat State
    chatMessages: [],
    chatInputValue: '',
    chatAttachments: [], // Array of { oasis_ref, kind, name }
    chatSending: false,

    // Operator Ticker State
    tickerEvents: [],

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

    // Toast Notifications (VTID-0517)
    toasts: [],

    // CI/CD Health (VTID-0520)
    cicdHealth: null,
    cicdHealthLoading: false,
    cicdHealthError: null,
    cicdHealthTooltipOpen: false
};

// --- Version History Data Model (VTID-0517) ---

/**
 * Version status constants for deployment entries.
 * @enum {string}
 */
const VersionStatus = {
    LIVE: 'live',
    DRAFT: 'draft',
    UNPUBLISHED: 'unpublished',
    UNKNOWN: 'unknown'
};

/**
 * Loads version history entries.
 * Phase 1: Returns mock data for UI development.
 *
 * TODO (future VTID): Replace mock data with real backend call, e.g.:
 * GET /api/v1/cicd/versions or /api/v1/oasis/events?topic=DEPLOYMENT
 * and map the response into VersionEntry[].
 *
 * @returns {Array<{id: string, vtid: string|null, label: string, status: string, createdAt: string, actor: string|null}>}
 */
function loadVersionHistory() {
    // Phase 1: Local mock data
    return [
        {
            id: 'deploy-001',
            vtid: 'DEV-OASIS-0108',
            label: 'OASIS tasks API endpoint',
            status: VersionStatus.LIVE,
            createdAt: '2025-11-28T08:14:42Z',
            actor: 'claude-agent'
        },
        {
            id: 'deploy-002',
            vtid: 'DEV-CICDL-0207',
            label: 'Safe merge CICD endpoints',
            status: VersionStatus.DRAFT,
            createdAt: '2025-11-27T15:30:00Z',
            actor: 'david.stevens'
        },
        {
            id: 'deploy-003',
            vtid: 'DEV-NAV-0045',
            label: 'Navigation operator update',
            status: VersionStatus.UNPUBLISHED,
            createdAt: '2025-11-26T10:45:00Z',
            actor: 'system'
        },
        {
            id: 'deploy-004',
            vtid: 'DEV-CSP-0043',
            label: 'Command Hub CSP compliance fix',
            status: VersionStatus.UNPUBLISHED,
            createdAt: '2025-11-25T18:22:15Z',
            actor: 'claude-agent'
        },
        {
            id: 'deploy-005',
            vtid: null,
            label: 'Gateway deploy r00164',
            status: VersionStatus.UNPUBLISHED,
            createdAt: '2025-11-24T09:00:00Z',
            actor: 'ci-pipeline'
        }
    ];
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

    // Modals
    if (state.showProfileModal) root.appendChild(renderProfileModal());
    if (state.showTaskModal) root.appendChild(renderTaskModal());

    // Global Overlays (VTID-0508)
    if (state.isHeartbeatOpen) root.appendChild(renderHeartbeatOverlay());
    if (state.isOperatorOpen) root.appendChild(renderOperatorOverlay());

    // Publish Modal (VTID-0517)
    if (state.showPublishModal) root.appendChild(renderPublishModal());

    // Toast Notifications (VTID-0517)
    if (state.toasts.length > 0) root.appendChild(renderToastContainer());
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

    // Profile at bottom (VTID-0508)
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

    sidebar.appendChild(profile);

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

function renderHeader() {
    const header = document.createElement('div');
    header.className = 'header-toolbar';

    // --- Left Section: Heartbeat, Autopilot, Operator, Clock (VTID-0517) ---
    const left = document.createElement('div');
    left.className = 'header-toolbar-left';

    // 1. Heartbeat button (status button style) - VTID-0509/0517/0523: Toggle with tri-state display
    const heartbeatBtn = document.createElement('button');
    // VTID-0523: Determine button class based on tri-state
    let heartbeatBtnClass = 'header-button header-button--status';
    let heartbeatStateLabel = 'Standby';
    if (state.heartbeatState === 'live') {
        heartbeatBtnClass += ' header-button--active';
        heartbeatStateLabel = 'Live';
    } else if (state.heartbeatState === 'degraded') {
        heartbeatBtnClass += ' header-button--degraded';
        heartbeatStateLabel = 'Degraded';
    }
    heartbeatBtn.className = heartbeatBtnClass;
    heartbeatBtn.innerHTML = `<span class="header-button__label">Heartbeat</span><span class="header-button__state">${heartbeatStateLabel}</span>`;
    heartbeatBtn.title = state.heartbeatState === 'degraded'
        ? 'Connection issues - Click to reconnect'
        : (state.heartbeatState === 'live' ? 'Click to stop live monitoring' : 'Click to start live monitoring');
    heartbeatBtn.onclick = () => {
        toggleHeartbeatSession();
    };
    left.appendChild(heartbeatBtn);

    // 2. Autopilot button (same style as Heartbeat)
    const autopilotBtn = document.createElement('button');
    autopilotBtn.className = 'header-button header-button--status';
    autopilotBtn.innerHTML = '<span class="header-button__label">Autopilot</span><span class="header-button__state">Standby</span>';
    left.appendChild(autopilotBtn);

    // 3. Operator button (primary action style)
    const operatorBtn = document.createElement('button');
    operatorBtn.className = 'header-button header-button--primary header-button--operator';
    operatorBtn.textContent = 'Operator';
    operatorBtn.onclick = () => {
        state.operatorActiveTab = 'chat';
        state.isOperatorOpen = true;
        renderApp();
    };
    left.appendChild(operatorBtn);

    // 4. Clock / Version History icon button
    const versionBtn = document.createElement('button');
    versionBtn.className = 'header-icon-button';
    versionBtn.title = 'Version History';
    // Clock icon using Unicode character (CSP compliant)
    versionBtn.innerHTML = '<span class="header-icon-button__icon">&#128337;</span>';
    versionBtn.onclick = (e) => {
        e.stopPropagation();
        state.isVersionDropdownOpen = !state.isVersionDropdownOpen;
        if (state.isVersionDropdownOpen) {
            // Load version history when opening
            state.versionHistory = loadVersionHistory();
        }
        renderApp();
    };
    left.appendChild(versionBtn);

    // Version History Dropdown (rendered within left for positioning)
    if (state.isVersionDropdownOpen) {
        left.appendChild(renderVersionDropdown());
    }

    header.appendChild(left);

    // --- Center Section: Publish button (VTID-0517) ---
    const center = document.createElement('div');
    center.className = 'header-toolbar-center';

    const publishBtn = document.createElement('button');
    publishBtn.className = 'header-button header-button--publish';
    publishBtn.textContent = 'Publish';
    publishBtn.onclick = () => {
        state.showPublishModal = true;
        renderApp();
    };
    center.appendChild(publishBtn);

    header.appendChild(center);

    // --- Right Section: Heartbeat indicator + CI/CD Health badge (VTID-0517/0520/0523) ---
    const right = document.createElement('div');
    right.className = 'header-toolbar-right';

    // VTID-0523: Green Heart Pill - Heartbeat State Indicator (read-only)
    const heartbeatIndicator = document.createElement('div');
    heartbeatIndicator.className = 'heartbeat-indicator';

    // Determine heartbeat state styling
    const heartPill = document.createElement('div');
    let heartPillClass = 'heartbeat-pill';
    let heartPillTitle = 'Heartbeat: Standby';
    let heartPillLabel = 'STANDBY';

    if (state.heartbeatState === 'live') {
        heartPillClass += ' heartbeat-pill--live';
        heartPillTitle = 'Heartbeat: Live - Streaming events';
        heartPillLabel = 'LIVE';
    } else if (state.heartbeatState === 'degraded') {
        heartPillClass += ' heartbeat-pill--degraded';
        heartPillTitle = 'Heartbeat: Degraded - Connection issues, retrying...';
        heartPillLabel = 'DEGRADED';
    } else {
        heartPillClass += ' heartbeat-pill--standby';
    }

    heartPill.className = heartPillClass;
    heartPill.title = heartPillTitle;

    // Heart icon with state-based animation
    const heartIcon = document.createElement('span');
    heartIcon.className = 'heartbeat-pill__icon';
    heartIcon.innerHTML = '&#9829;'; // ♥
    heartPill.appendChild(heartIcon);

    // State label
    const heartLabel = document.createElement('span');
    heartLabel.className = 'heartbeat-pill__label';
    heartLabel.textContent = heartPillLabel;
    heartPill.appendChild(heartLabel);

    heartbeatIndicator.appendChild(heartPill);
    right.appendChild(heartbeatIndicator);

    // CI/CD Health Badge (VTID-0520) - Separate from heartbeat, text-only badge
    const cicdHealthIndicator = document.createElement('div');
    cicdHealthIndicator.className = 'cicd-health-indicator';

    // Determine health status
    const isHealthy = state.cicdHealth && state.cicdHealth.ok === true;
    const hasError = state.cicdHealthError !== null || (state.cicdHealth && state.cicdHealth.ok === false);
    const isLoading = state.cicdHealthLoading && !state.cicdHealth;

    // Create CI/CD health badge (button for tooltip)
    const cicdBtn = document.createElement('button');
    if (isLoading) {
        cicdBtn.className = 'cicd-health-badge cicd-health-badge--loading';
        cicdBtn.textContent = 'CI/CD...';
        cicdBtn.title = 'CI/CD: Loading...';
    } else if (hasError) {
        cicdBtn.className = 'cicd-health-badge cicd-health-badge--error';
        cicdBtn.textContent = 'CI/CD Issues';
        cicdBtn.title = state.cicdHealthError || 'CI/CD Issues';
    } else if (isHealthy) {
        cicdBtn.className = 'cicd-health-badge cicd-health-badge--healthy';
        cicdBtn.textContent = 'CI/CD OK';
        cicdBtn.title = 'CI/CD Healthy';
    } else {
        cicdBtn.className = 'cicd-health-badge cicd-health-badge--unknown';
        cicdBtn.textContent = 'CI/CD ?';
        cicdBtn.title = 'CI/CD: Unknown';
    }

    // Click handler to show tooltip/popup
    cicdBtn.onclick = (e) => {
        e.stopPropagation();
        state.cicdHealthTooltipOpen = !state.cicdHealthTooltipOpen;
        renderApp();
    };

    cicdHealthIndicator.appendChild(cicdBtn);

    // Tooltip/popup with full status (VTID-0520)
    if (state.cicdHealthTooltipOpen) {
        const tooltip = document.createElement('div');
        tooltip.className = 'cicd-health-tooltip';

        // Header
        const tooltipHeader = document.createElement('div');
        tooltipHeader.className = 'cicd-health-tooltip__header';
        tooltipHeader.innerHTML = isHealthy
            ? '<span class="cicd-health-tooltip__status cicd-health-tooltip__status--healthy">CI/CD Healthy</span>'
            : '<span class="cicd-health-tooltip__status cicd-health-tooltip__status--error">CI/CD Issues</span>';
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

        // Click-outside handler
        setTimeout(() => {
            const closeTooltip = (e) => {
                const tooltipEl = document.querySelector('.cicd-health-tooltip');
                const btnEl = document.querySelector('.cicd-health-badge');
                if (tooltipEl && !tooltipEl.contains(e.target) && btnEl && !btnEl.contains(e.target)) {
                    state.cicdHealthTooltipOpen = false;
                    document.removeEventListener('click', closeTooltip);
                    renderApp();
                }
            };
            document.addEventListener('click', closeTooltip);
        }, 0);
    }

    right.appendChild(cicdHealthIndicator);

    // VTID-0523: Removed redundant static LIVE pill - heartbeat indicator now shows state

    header.appendChild(right);

    // Add click-outside handler for dropdown
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

// --- Version History Dropdown (VTID-0517) ---

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

    state.versionHistory.forEach(version => {
        const item = document.createElement('div');
        item.className = 'version-dropdown__item';
        if (state.selectedVersionId === version.id) {
            item.className += ' version-dropdown__item--selected';
        }

        // Primary label with VTID or just label
        const label = document.createElement('div');
        label.className = 'version-dropdown__item-label';
        label.textContent = version.vtid
            ? version.vtid + ' – ' + version.label
            : version.label;
        item.appendChild(label);

        // Meta line: timestamp + optional status badge
        const meta = document.createElement('div');
        meta.className = 'version-dropdown__item-meta';

        const timestamp = document.createElement('span');
        timestamp.className = 'version-dropdown__item-timestamp';
        timestamp.textContent = formatVersionTimestamp(version.createdAt);
        meta.appendChild(timestamp);

        if (version.status) {
            const badge = document.createElement('span');
            badge.className = 'version-dropdown__item-badge version-dropdown__item-badge--' + version.status;
            badge.textContent = version.status.charAt(0).toUpperCase() + version.status.slice(1);
            meta.appendChild(badge);
        }

        item.appendChild(meta);

        // Click handler
        item.onclick = (e) => {
            e.stopPropagation();
            state.selectedVersionId = version.id;
            const displayName = version.vtid || version.label;
            showToast('Version ' + displayName + ' selected. Restore/publish flow will be implemented in a later step.', 'info');
            state.isVersionDropdownOpen = false;
            renderApp();
        };

        list.appendChild(item);
    });

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
    } else if (moduleKey === 'docs' && tab === 'screens') {
        container.appendChild(renderDocsScreensView());
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
        renderApp();
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

    return card;
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

    drawer.appendChild(content);

    return drawer;
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

    const vtidGroup = document.createElement('div');
    vtidGroup.className = 'form-group';
    vtidGroup.innerHTML = '<label>VTID</label><input type="text" class="form-control" placeholder="VTID-XXXX">';
    body.appendChild(vtidGroup);

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
        const statusSelect = body.querySelector('.form-group:nth-child(3) select');

        const title = titleInput.value.trim();
        const vtid = vtidInput.value.trim();
        const status = statusSelect.value; // "Scheduled", "In Progress", "Completed"

        // Basic validation
        if (!title) {
            alert('Title is required');
            return;
        }

        if (!vtid) {
            alert('VTID is required');
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

        // Prepare payload
        const payload = {
            title: title,
            vtid: vtid,
            status: backendStatus
        };

        try {
            // Disable button to prevent double-submit
            createBtn.disabled = true;
            createBtn.textContent = 'Creating...';

            const response = await fetch('/api/v1/oasis/tasks', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorData = await response.json();
                alert(`Error creating task: ${errorData.error || 'Unknown error'}`);
                createBtn.disabled = false;
                createBtn.textContent = 'Create';
                return;
            }

            // Success! Close modal and refresh task list
            state.showTaskModal = false;
            fetchTasks(); // Refresh the task board
            renderApp();
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
    // 1. Try to find exact tab match
    for (const section of NAVIGATION_CONFIG) {
        for (const tab of section.tabs) {
            if (pathname === tab.path) {
                return { section: section.section, tab: tab.key };
            }
        }
    }

    // 2. Try to find section base path match
    for (const section of NAVIGATION_CONFIG) {
        if (pathname === section.basePath) {
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

    // VTID-0523: Subtitle shows current heartbeat state with guidance (text only, no toggle)
    const subtitle = document.createElement('div');
    subtitle.className = 'overlay-subtitle';
    let heartbeatStateText = 'Standby';
    let heartbeatStateClass = '';
    if (state.heartbeatState === 'live') {
        heartbeatStateText = 'Live';
        heartbeatStateClass = 'overlay-subtitle--live';
    } else if (state.heartbeatState === 'degraded') {
        heartbeatStateText = 'Degraded';
        heartbeatStateClass = 'overlay-subtitle--degraded';
    }
    subtitle.innerHTML = `Heartbeat: <span class="overlay-subtitle__state ${heartbeatStateClass}">${heartbeatStateText}</span> – use top Heartbeat toggle to change`;
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
        state.chatMessages.forEach(msg => {
            const msgEl = document.createElement('div');
            msgEl.className = `chat-message ${msg.type}${msg.isError ? ' error' : ''}`;

            const bubble = document.createElement('div');
            bubble.className = 'chat-message-bubble';
            bubble.textContent = msg.content;
            msgEl.appendChild(bubble);

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
                msgEl.appendChild(attachmentsEl);
            }

            const time = document.createElement('div');
            time.className = 'chat-message-time';
            time.textContent = msg.timestamp;
            msgEl.appendChild(time);

            messages.appendChild(msgEl);
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
    textarea.oninput = (e) => {
        state.chatInputValue = e.target.value;
    };
    textarea.onkeydown = (e) => {
        if (e.key === 'Enter' && e.ctrlKey && state.chatInputValue.trim()) {
            e.preventDefault();
            sendChatMessage();
        }
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

async function sendChatMessage() {
    if (state.chatSending) return;

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

    try {
        const response = await fetch('/api/v1/operator/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: messageText,
                attachments: attachments
            })
        });

        if (!response.ok) {
            throw new Error(`Chat request failed: ${response.status}`);
        }

        const result = await response.json();
        console.log('[Operator] Chat response:', result);

        // Add AI response
        state.chatMessages.push({
            type: 'system',
            content: result.reply || 'No response received',
            timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            oasis_ref: result.oasis_ref
        });

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

        // Re-focus textarea after sending - CRITICAL UX RULE
        setTimeout(() => {
            const textarea = document.querySelector('.chat-textarea');
            if (textarea) textarea.focus();
        }, 50);
    }
}

function renderOperatorTicker() {
    const container = document.createElement('div');
    container.className = 'ticker-container';

    // VTID-0523: Heartbeat status banner with tri-state support
    const statusBanner = document.createElement('div');
    let bannerClass = 'ticker-status-banner';
    if (state.heartbeatState === 'live') {
        bannerClass += ' ticker-live';
    } else if (state.heartbeatState === 'degraded') {
        bannerClass += ' ticker-degraded';
    } else {
        bannerClass += ' ticker-standby';
    }
    statusBanner.className = bannerClass;

    // VTID-0523: Render status banner based on tri-state
    if (state.heartbeatState === 'live' && state.operatorHeartbeatSnapshot) {
        const snapshot = state.operatorHeartbeatSnapshot;
        statusBanner.innerHTML = `
            <div class="ticker-status-row">
                <span class="ticker-status-label">Status:</span>
                <span class="ticker-status-value status-live">LIVE</span>
                <span class="ticker-status-label">Tasks:</span>
                <span class="ticker-status-value">${snapshot.tasks?.total || 0}</span>
                <span class="ticker-status-label">CICD:</span>
                <span class="ticker-status-value status-${snapshot.cicd?.status || 'ok'}">${snapshot.cicd?.status || 'OK'}</span>
            </div>
            <div class="ticker-status-row ticker-status-tasks">
                <span>Scheduled: ${snapshot.tasks?.by_status?.scheduled || 0}</span>
                <span>In Progress: ${snapshot.tasks?.by_status?.in_progress || 0}</span>
                <span>Completed: ${snapshot.tasks?.by_status?.completed || 0}</span>
            </div>
        `;
    } else if (state.heartbeatState === 'degraded') {
        statusBanner.innerHTML = `
            <div class="ticker-status-row">
                <span class="ticker-status-value status-degraded">DEGRADED</span>
                <span class="ticker-hint ticker-hint--warning">Connection issues - retrying automatically (${state.heartbeatRetryCount}/${state.heartbeatMaxRetries})</span>
            </div>
            <div class="ticker-status-row ticker-degraded-info">
                <span>Events may be delayed. Use the Heartbeat toggle to reconnect.</span>
            </div>
        `;
    } else if (state.heartbeatState === 'off') {
        statusBanner.innerHTML = `
            <div class="ticker-status-row">
                <span class="ticker-status-value status-standby">STANDBY</span>
                <span class="ticker-hint">Enable Heartbeat to see live events</span>
            </div>
        `;
    } else if (state.heartbeatState === 'live') {
        // Live but no snapshot yet
        statusBanner.innerHTML = `
            <div class="ticker-status-row">
                <span class="ticker-status-value status-live">LIVE</span>
                <span>Loading snapshot...</span>
            </div>
        `;
    }
    container.appendChild(statusBanner);

    // Events list
    const eventsList = document.createElement('div');
    eventsList.className = 'ticker-events-list';

    // VTID-0523: Update empty state message based on tri-state
    if (state.tickerEvents.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ticker-empty';
        if (state.heartbeatState === 'live') {
            empty.textContent = 'Waiting for events...';
        } else if (state.heartbeatState === 'degraded') {
            empty.textContent = 'Connection degraded - events may be delayed';
        } else {
            empty.textContent = 'Enable heartbeat to see live events';
        }
        eventsList.appendChild(empty);
    } else {
        state.tickerEvents.forEach(event => {
            const item = document.createElement('div');
            item.className = 'ticker-item';

            const timestamp = document.createElement('div');
            timestamp.className = 'ticker-timestamp';
            timestamp.textContent = event.timestamp;
            item.appendChild(timestamp);

            const content = document.createElement('div');
            content.className = 'ticker-content';
            content.textContent = event.content;
            item.appendChild(content);

            const type = document.createElement('div');
            type.className = `ticker-type ticker-type-${event.type}`;
            type.textContent = event.type;
            item.appendChild(type);

            eventsList.appendChild(item);
        });
    }

    container.appendChild(eventsList);

    return container;
}

function renderOperatorHistory() {
    const container = document.createElement('div');
    container.className = 'history-container';

    // Header with refresh button
    const header = document.createElement('div');
    header.className = 'history-header';

    const title = document.createElement('span');
    title.textContent = 'Event History';
    header.appendChild(title);

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn history-refresh-btn';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.onclick = () => fetchOperatorHistory();
    header.appendChild(refreshBtn);

    container.appendChild(header);

    // Content
    const content = document.createElement('div');
    content.className = 'history-content';

    if (state.historyLoading) {
        content.innerHTML = '<div class="history-loading">Loading history...</div>';
    } else if (state.historyError) {
        content.innerHTML = `<div class="history-error">Error: ${state.historyError}</div>`;
    } else if (state.historyEvents.length === 0) {
        content.innerHTML = '<div class="history-empty">No history events yet. Click Refresh to load.</div>';
        // Auto-fetch on first open
        if (!state.historyLoading) {
            setTimeout(() => fetchOperatorHistory(), 100);
        }
    } else {
        // Render history table
        const table = document.createElement('table');
        table.className = 'history-table';

        const thead = document.createElement('thead');
        thead.innerHTML = `
            <tr>
                <th>Type</th>
                <th>Status</th>
                <th>VTID</th>
                <th>Time</th>
                <th>Summary</th>
            </tr>
        `;
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        state.historyEvents.forEach(event => {
            const tr = document.createElement('tr');
            const timeStr = new Date(event.created_at).toLocaleString();
            tr.innerHTML = `
                <td class="history-type">${event.type}</td>
                <td class="history-status history-status-${event.status}">${event.status}</td>
                <td class="history-vtid">${event.vtid || '-'}</td>
                <td class="history-time">${timeStr}</td>
                <td class="history-summary">${event.summary}</td>
            `;
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        content.appendChild(table);
    }

    container.appendChild(content);
    return container;
}

// --- Publish Modal (VTID-0517 + VTID-0523) ---

// VTID-0523: State for deployment pipeline
let deployState = {
    isDeploying: false,
    steps: [],
    error: null,
    result: null
};

async function runDeployPipeline(service, environment) {
    deployState.isDeploying = true;
    deployState.steps = [
        { name: 'create-pr', status: 'pending' },
        { name: 'safe-merge', status: 'pending' },
        { name: 'deploy-service', status: 'pending' }
    ];
    deployState.error = null;
    deployState.result = null;
    renderApp();

    console.log(`[VTID-0523] Starting deployment: ${service} -> ${environment}`);

    try {
        const payload = {
            vtid: 'VTID-0523',
            service: service,
            environment: environment,
            skip_pr: true,      // Skip PR for direct deploy
            skip_merge: true,   // Skip merge for direct deploy
            trigger_workflow: false  // Dry run for safety
        };

        const response = await fetch('/api/v1/operator/deploy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        console.log('[VTID-0523] Deploy result:', result);

        deployState.result = result;

        if (result.ok && result.data) {
            deployState.steps = result.data.steps || deployState.steps;
            showToast('Deployment pipeline completed successfully!', 'success');

            // Add to ticker events
            state.tickerEvents.unshift({
                id: Date.now(),
                timestamp: new Date().toLocaleTimeString(),
                type: 'deploy',
                content: `Deploy ${service} to ${environment} completed`
            });
        } else {
            deployState.error = result.error || 'Unknown error';
            showToast(`Deployment failed: ${deployState.error}`, 'error');

            // Add failure to ticker
            state.tickerEvents.unshift({
                id: Date.now(),
                timestamp: new Date().toLocaleTimeString(),
                type: 'deploy',
                content: `Deploy ${service} failed: ${deployState.error}`
            });
        }
    } catch (error) {
        console.error('[VTID-0523] Deploy error:', error);
        deployState.error = error.message;
        showToast(`Deployment error: ${error.message}`, 'error');
    } finally {
        deployState.isDeploying = false;
        renderApp();
    }
}

function renderPublishModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => {
        if (e.target === overlay && !deployState.isDeploying) {
            state.showPublishModal = false;
            deployState = { isDeploying: false, steps: [], error: null, result: null };
            renderApp();
        }
    };

    const modal = document.createElement('div');
    modal.className = 'modal publish-modal';

    // Header
    const header = document.createElement('div');
    header.className = 'modal-header';
    header.textContent = deployState.isDeploying ? 'Deploying...' : 'Deploy Gateway Service';
    modal.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'modal-body';

    if (deployState.isDeploying || deployState.result) {
        // Show pipeline progress
        const stepsContainer = document.createElement('div');
        stepsContainer.className = 'deploy-steps';

        deployState.steps.forEach(step => {
            const stepEl = document.createElement('div');
            stepEl.className = `deploy-step deploy-step--${step.status}`;

            const stepIcon = document.createElement('span');
            stepIcon.className = 'deploy-step__icon';
            if (step.status === 'success') stepIcon.textContent = '✓';
            else if (step.status === 'error') stepIcon.textContent = '✗';
            else if (step.status === 'running') stepIcon.textContent = '⟳';
            else if (step.status === 'skipped') stepIcon.textContent = '⊘';
            else stepIcon.textContent = '○';
            stepEl.appendChild(stepIcon);

            const stepName = document.createElement('span');
            stepName.className = 'deploy-step__name';
            stepName.textContent = step.name.replace(/-/g, ' ');
            stepEl.appendChild(stepName);

            if (step.detail) {
                const stepDetail = document.createElement('span');
                stepDetail.className = 'deploy-step__detail';
                stepDetail.textContent = step.detail;
                stepEl.appendChild(stepDetail);
            }

            stepsContainer.appendChild(stepEl);
        });

        body.appendChild(stepsContainer);

        if (deployState.error) {
            const errorMsg = document.createElement('div');
            errorMsg.className = 'deploy-error';
            errorMsg.textContent = deployState.error;
            body.appendChild(errorMsg);
        }

        if (deployState.result && deployState.result.ok) {
            const successMsg = document.createElement('div');
            successMsg.className = 'deploy-success';
            successMsg.textContent = 'Pipeline completed successfully!';
            body.appendChild(successMsg);
        }
    } else {
        // Initial state - show deploy options
        const message = document.createElement('p');
        message.className = 'publish-modal__message';
        message.textContent = 'This will run the deployment pipeline for the Gateway service. The pipeline validates and prepares the service for deployment.';
        body.appendChild(message);

        const serviceInfo = document.createElement('div');
        serviceInfo.className = 'deploy-info';
        serviceInfo.innerHTML = `
            <div class="deploy-info__row"><span>Service:</span><strong>gateway</strong></div>
            <div class="deploy-info__row"><span>Environment:</span><strong>dev</strong></div>
            <div class="deploy-info__row"><span>Mode:</span><strong>Validation (dry run)</strong></div>
        `;
        body.appendChild(serviceInfo);
    }

    modal.appendChild(body);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'modal-footer';

    if (!deployState.isDeploying) {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn';
        cancelBtn.textContent = deployState.result ? 'Close' : 'Cancel';
        cancelBtn.onclick = () => {
            state.showPublishModal = false;
            deployState = { isDeploying: false, steps: [], error: null, result: null };
            renderApp();
        };
        footer.appendChild(cancelBtn);
    }

    if (!deployState.result && !deployState.isDeploying) {
        const publishBtn = document.createElement('button');
        publishBtn.className = 'btn btn-primary';
        publishBtn.textContent = 'Deploy';
        publishBtn.onclick = () => {
            runDeployPipeline('gateway', 'dev');
        };
        footer.appendChild(publishBtn);
    }

    modal.appendChild(footer);
    overlay.appendChild(modal);

    return overlay;
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
 * VTID-0523: Updated to use tri-state model (off | live | degraded)
 */
async function toggleHeartbeatSession() {
    const isCurrentlyActive = state.heartbeatState !== 'off';
    const newStatus = isCurrentlyActive ? 'standby' : 'live';
    console.log(`[Operator] Toggling heartbeat to: ${newStatus} (current state: ${state.heartbeatState})`);

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

        if (newStatus === 'live') {
            // VTID-0523: Set heartbeat state to 'live' (will change to 'degraded' on SSE error)
            state.operatorHeartbeatActive = true;
            state.heartbeatState = 'live';
            state.heartbeatRetryCount = 0;
            // Fetch heartbeat snapshot
            await fetchHeartbeatSnapshot();
            // Start SSE stream
            startOperatorSse();
            // Open operator console on ticker tab
            state.operatorActiveTab = 'ticker';
            state.isOperatorOpen = true;
        } else {
            // VTID-0523: Set heartbeat state to 'off'
            state.operatorHeartbeatActive = false;
            state.heartbeatState = 'off';
            state.heartbeatRetryCount = 0;
            // Stop SSE stream
            stopOperatorSse();
        }

        renderApp();

    } catch (error) {
        console.error('[Operator] Session toggle error:', error);
        // VTID-0523: Set to degraded if we failed while trying to go live
        if (newStatus === 'live') {
            state.heartbeatState = 'degraded';
            renderApp();
        }
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

        // Add snapshot events to ticker
        if (snapshot.events && snapshot.events.length > 0) {
            snapshot.events.forEach(event => {
                state.tickerEvents.unshift({
                    id: Date.now() + Math.random(),
                    timestamp: new Date(event.created_at).toLocaleTimeString(),
                    type: event.type.split('.')[0] || 'info',
                    content: event.summary
                });
            });
        }

    } catch (error) {
        console.error('[Operator] Heartbeat snapshot error:', error);
    }
}

/**
 * Start SSE stream for operator channel
 * VTID-0523: Added proper error handling with retry logic and degraded state
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
        // VTID-0523: Reset retry count and confirm live state on successful connection
        state.heartbeatRetryCount = 0;
        if (state.heartbeatState === 'degraded') {
            state.heartbeatState = 'live';
            renderApp();
        }
    };

    eventSource.addEventListener('connected', (e) => {
        console.log('[Operator] SSE connection confirmed:', e.data);
        // VTID-0523: Confirm live state on successful handshake
        state.heartbeatState = 'live';
        state.heartbeatRetryCount = 0;
        renderApp();
    });

    eventSource.addEventListener('oasis-event', (e) => {
        try {
            const event = JSON.parse(e.data);
            console.log('[Operator] SSE event:', event);

            // Add to ticker
            state.tickerEvents.unshift({
                id: event.id || Date.now(),
                timestamp: new Date(event.created_at).toLocaleTimeString(),
                type: event.type?.split('.')[0] || 'info',
                content: event.payload?.message || event.type || 'Event received'
            });

            // Keep only last 100 events
            if (state.tickerEvents.length > 100) {
                state.tickerEvents = state.tickerEvents.slice(0, 100);
            }

            renderApp();
        } catch (err) {
            console.error('[Operator] SSE event parse error:', err);
        }
    });

    // VTID-0523: Handle error events from SSE
    eventSource.addEventListener('error', (e) => {
        try {
            const errData = JSON.parse(e.data);
            console.error('[Operator] SSE error event:', errData);
            handleSseError(errData.error || 'Stream error');
        } catch (parseErr) {
            // Not a parseable error event
        }
    });

    eventSource.onerror = (err) => {
        console.error('[Operator] SSE connection error:', err);
        handleSseError('Connection lost');
    };

    state.operatorSseSource = eventSource;
}

/**
 * Handle SSE errors with retry logic
 * VTID-0523: Implements graceful degradation with retries
 */
function handleSseError(errorMessage) {
    console.log(`[Operator] Handling SSE error: ${errorMessage} (retry ${state.heartbeatRetryCount}/${state.heartbeatMaxRetries})`);

    // Close existing connection
    if (state.operatorSseSource) {
        state.operatorSseSource.close();
        state.operatorSseSource = null;
    }

    // Check if we should retry
    if (state.heartbeatRetryCount < state.heartbeatMaxRetries && state.heartbeatState !== 'off') {
        state.heartbeatRetryCount++;
        state.heartbeatState = 'degraded';
        renderApp();

        // Exponential backoff: 2s, 4s, 8s
        const retryDelay = Math.pow(2, state.heartbeatRetryCount) * 1000;
        console.log(`[Operator] Retrying SSE connection in ${retryDelay}ms...`);

        setTimeout(() => {
            if (state.heartbeatState !== 'off') {
                startOperatorSse();
            }
        }, retryDelay);
    } else if (state.heartbeatState !== 'off') {
        // Max retries exceeded, stay in degraded state
        state.heartbeatState = 'degraded';
        console.error('[Operator] SSE max retries exceeded, staying in degraded state');
        renderApp();
    }
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

        // VTID-0520: Start CI/CD health polling
        startCicdHealthPolling();
    } catch (e) {
        console.error('Critical Render Error:', e);
        document.body.innerHTML = `<div class="critical-error"><h1>Critical Error</h1><pre>${e.stack}</pre></div>`;
    }
});
