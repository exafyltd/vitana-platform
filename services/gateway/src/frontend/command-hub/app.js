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
    selectedRole: 'DEVELOPER'
};

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
}

function renderSidebar() {
    const sidebar = document.createElement('div');
    sidebar.className = `sidebar ${state.sidebarCollapsed ? 'collapsed' : ''}`;

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
    header.className = 'header-bar';

    // Left: Title + Autopilot Card
    const left = document.createElement('div');
    left.className = 'header-left';

    const title = document.createElement('div');
    title.className = 'header-title';
    title.innerHTML = 'Command Hub <span style="font-size:0.7em; background:#333; padding:2px 6px; border-radius:4px; margin-left:8px;">v4</span>';
    left.appendChild(title);

    const autopilot = document.createElement('div');
    autopilot.className = 'autopilot-card';
    autopilot.innerHTML = `
    <span class="title">Autopilot</span>
    <span class="status">Standby</span>
  `;
    left.appendChild(autopilot);

    const live = document.createElement('div');
    live.className = 'live-indicator';
    live.innerHTML = `
    <div class="live-dot"></div>
    LIVE
  `;
    left.appendChild(live);

    header.appendChild(left);

    // Right: Multimodal Controls & Profile
    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '1rem';
    right.style.alignItems = 'center';

    const mmControls = document.createElement('div');
    mmControls.className = 'multimodal-controls';

    // Split Screen Toggle
    const splitBtn = document.createElement('select');
    splitBtn.className = 'form-control';
    splitBtn.style.width = 'auto';
    splitBtn.style.padding = '0.25rem 0.5rem';
    splitBtn.style.fontSize = '0.8rem';
    splitBtn.innerHTML = '<option value="">Single View</option>';
    splitScreenCombos.forEach(combo => {
        const opt = document.createElement('option');
        opt.value = combo.id;
        opt.textContent = combo.label;
        if (state.activeSplitScreenId === combo.id) opt.selected = true;
        splitBtn.appendChild(opt);
    });
    splitBtn.onchange = (e) => handleSplitScreenToggle(e.target.value);
    right.appendChild(splitBtn);

    const micBtn = document.createElement('button');
    micBtn.className = 'mm-btn';
    micBtn.innerHTML = '🎤'; // Placeholder icon
    micBtn.title = 'Toggle Voice';

    const camBtn = document.createElement('button');
    camBtn.className = 'mm-btn';
    camBtn.innerHTML = '📷'; // Placeholder icon
    camBtn.title = 'Toggle Camera';

    const streamBtn = document.createElement('button');
    streamBtn.className = 'mm-btn';
    streamBtn.innerHTML = '📡'; // Placeholder icon
    streamBtn.title = 'Toggle Stream';

    mmControls.appendChild(micBtn);
    mmControls.appendChild(camBtn);
    mmControls.appendChild(streamBtn);
    right.appendChild(mmControls);

    // Profile Avatar
    const avatar = document.createElement('div');
    avatar.style.width = '32px';
    avatar.style.height = '32px';
    avatar.style.borderRadius = '50%';
    avatar.style.background = 'var(--color-accent)';
    avatar.style.display = 'flex';
    avatar.style.alignItems = 'center';
    avatar.style.justifyContent = 'center';
    avatar.style.fontSize = '0.8rem';
    avatar.style.fontWeight = 'bold';
    avatar.style.cursor = 'pointer';
    avatar.textContent = state.user.avatar;
    avatar.onclick = () => {
        state.showProfileModal = true;
        renderApp();
    };
    right.appendChild(avatar);

    header.appendChild(right);

    return header;
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
    moduleContent.style.flex = '1';
    moduleContent.style.overflow = 'hidden';

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
    leftHeader.style.padding = '0.5rem 1rem';
    leftHeader.style.background = 'var(--color-sidebar-bg)';
    leftHeader.style.borderBottom = '1px solid var(--color-border)';
    leftHeader.style.fontSize = '0.8rem';
    leftHeader.style.fontWeight = '600';
    leftHeader.style.color = 'var(--color-text-secondary)';
    leftHeader.textContent = `${SECTION_LABELS[state.leftPane.module] || state.leftPane.module} > ${formatTabLabel(state.leftPane.tab)}`;
    left.appendChild(leftHeader);

    const leftContent = document.createElement('div');
    leftContent.style.flex = '1';
    leftContent.style.overflow = 'hidden';
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
    rightHeader.style.padding = '0.5rem 1rem';
    rightHeader.style.background = 'var(--color-sidebar-bg)';
    rightHeader.style.borderBottom = '1px solid var(--color-border)';
    rightHeader.style.fontSize = '0.8rem';
    rightHeader.style.fontWeight = '600';
    rightHeader.style.color = 'var(--color-text-secondary)';
    rightHeader.textContent = `${SECTION_LABELS[state.rightPane.module] || state.rightPane.module} > ${formatTabLabel(state.rightPane.tab)}`;
    right.appendChild(rightHeader);

    const rightContent = document.createElement('div');
    rightContent.style.flex = '1';
    rightContent.style.overflow = 'hidden';
    rightContent.appendChild(renderModuleContent(state.rightPane.module, state.rightPane.tab));
    right.appendChild(rightContent);

    split.appendChild(right);

    return split;
}

function renderModuleContent(moduleKey, tab) {
    const container = document.createElement('div');
    container.style.height = '100%';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';

    if (moduleKey === 'command-hub' && tab === 'tasks') {
        container.appendChild(renderTasksView());
    } else if (moduleKey === 'docs' && tab === 'screens') {
        container.appendChild(renderDocsScreensView());
    } else {
        // Placeholder for other modules
        const placeholder = document.createElement('div');
        placeholder.style.padding = '2rem';
        placeholder.style.color = 'var(--color-text-secondary)';

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
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.height = '100%';

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
    dateFilter.className = 'form-control';
    dateFilter.style.width = 'auto';
    dateFilter.style.marginLeft = '1rem';
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
    refreshBtn.className = 'btn';
    refreshBtn.textContent = '↻';
    refreshBtn.style.marginLeft = '0.5rem';
    refreshBtn.onclick = () => {
        fetchTasks();
    };
    toolbar.appendChild(refreshBtn);

    container.appendChild(toolbar);

    // Golden Task Board
    const board = document.createElement('div');
    board.className = 'task-board';

    if (state.tasksLoading) {
        board.innerHTML = '<div style="padding: 2rem; color: var(--color-text-secondary);">Loading tasks...</div>';
        container.appendChild(board);
        return container;
    }

    if (state.tasksError) {
        board.innerHTML = `<div style="padding: 2rem; color: #ef4444;">Error: ${state.tasksError}</div>`;
        container.appendChild(board);
        return container;
    }

    const columns = ['Scheduled', 'In Progress', 'Completed'];

    // Check if there are any tasks at all
    if (state.tasks.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.style.gridColumn = '1 / -1';
        emptyState.style.display = 'flex';
        emptyState.style.flexDirection = 'column';
        emptyState.style.alignItems = 'center';
        emptyState.style.justifyContent = 'center';
        emptyState.style.padding = '3rem';
        emptyState.style.color = 'var(--color-text-secondary)';
        emptyState.innerHTML = `
            <div style="font-size: 3rem; margin-bottom: 1rem;">📋</div>
            <div style="font-size: 1.1rem; font-weight: 500; margin-bottom: 0.5rem;">No tasks found</div>
            <div style="font-size: 0.9rem;">Click "+ New Task" to create your first task, or tasks will appear here once created via OASIS.</div>
        `;
        board.appendChild(emptyState);
        container.appendChild(board);
        return container;
    }

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
                const vtid = t.vtid || '';
                if (!t.title.toLowerCase().includes(q) && !vtid.toLowerCase().includes(q)) return false;
            }

            // Date filter (assuming createdAt exists and is YYYY-MM-DD compatible or ISO)
            if (state.taskDateFilter && t.createdAt) {
                if (!t.createdAt.startsWith(state.taskDateFilter)) return false;
            }

            return true;
        });

        if (colTasks.length === 0) {
            const emptyCol = document.createElement('div');
            emptyCol.style.padding = '1rem';
            emptyCol.style.color = 'var(--color-text-secondary)';
            emptyCol.style.fontSize = '0.85rem';
            emptyCol.style.textAlign = 'center';
            emptyCol.style.fontStyle = 'italic';
            emptyCol.textContent = 'No tasks';
            content.appendChild(emptyCol);
        } else {
            colTasks.forEach(task => {
                content.appendChild(createTaskCard(task));
            });
        }

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
    title.textContent = task.title || 'Untitled Task';
    card.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'meta';

    const vtid = document.createElement('span');
    vtid.className = 'vtid';
    vtid.textContent = task.vtid || `#${task.id || '—'}`;
    meta.appendChild(vtid);

    const status = document.createElement('span');
    status.textContent = task.status || 'pending';
    meta.appendChild(status);

    card.appendChild(meta);

    // Show layer/module if available
    if (task.layer || task.module) {
        const layerMod = document.createElement('div');
        layerMod.style.fontSize = '0.7rem';
        layerMod.style.color = 'var(--color-text-secondary)';
        layerMod.style.marginTop = '0.5rem';
        layerMod.textContent = [task.layer, task.module].filter(Boolean).join(' / ');
        card.appendChild(layerMod);
    }

    return card;
}

function renderTaskDrawer() {
    const drawer = document.createElement('div');
    drawer.className = `task-drawer ${state.selectedTask ? 'open' : ''}`;

    if (!state.selectedTask) return drawer;

    const task = state.selectedTask;

    const header = document.createElement('div');
    header.className = 'drawer-header';

    const title = document.createElement('h2');
    title.style.margin = '0';
    title.style.fontSize = '1.25rem';
    title.style.color = 'var(--color-accent)';
    title.textContent = task.vtid || `Task #${task.id || '—'}`;
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.style.background = 'transparent';
    closeBtn.style.border = 'none';
    closeBtn.style.color = 'var(--color-text-secondary)';
    closeBtn.style.fontSize = '1.5rem';
    closeBtn.style.cursor = 'pointer';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => {
        state.selectedTask = null;
        renderApp();
    };
    header.appendChild(closeBtn);

    drawer.appendChild(header);

    const content = document.createElement('div');
    content.className = 'drawer-content';

    // Task title
    const titleEl = document.createElement('h3');
    titleEl.style.margin = '0 0 1rem 0';
    titleEl.style.color = 'var(--color-text-primary)';
    titleEl.style.fontSize = '1.1rem';
    titleEl.textContent = task.title || 'Untitled Task';
    content.appendChild(titleEl);

    // Summary
    if (task.summary) {
        const summary = document.createElement('p');
        summary.style.color = 'var(--color-text-primary)';
        summary.style.marginBottom = '1rem';
        summary.textContent = task.summary;
        content.appendChild(summary);
    }

    // Description
    if (task.description) {
        const descLabel = document.createElement('div');
        descLabel.style.color = 'var(--color-text-secondary)';
        descLabel.style.fontSize = '0.8rem';
        descLabel.style.marginBottom = '0.25rem';
        descLabel.style.textTransform = 'uppercase';
        descLabel.textContent = 'Description';
        content.appendChild(descLabel);

        const descContent = document.createElement('p');
        descContent.style.color = 'var(--color-text-primary)';
        descContent.style.marginBottom = '1.5rem';
        descContent.style.whiteSpace = 'pre-wrap';
        descContent.textContent = task.description;
        content.appendChild(descContent);
    }

    // Details grid
    const details = document.createElement('div');
    details.style.marginTop = '1.5rem';
    details.style.display = 'grid';
    details.style.gridTemplateColumns = '1fr 1fr';
    details.style.gap = '1rem';
    details.style.fontSize = '0.875rem';

    const detailItems = [
        { label: 'Status', value: task.status || 'pending' },
        { label: 'Layer', value: task.layer || '—' },
        { label: 'Module', value: task.module || '—' },
        { label: 'Assigned To', value: task.assigned_to || 'Unassigned' },
        { label: 'Created', value: task.createdAt ? new Date(task.createdAt).toLocaleString() : 'N/A' }
    ];

    detailItems.forEach(item => {
        const detailItem = document.createElement('div');
        detailItem.innerHTML = `
            <div style="color: var(--color-text-secondary); font-size: 0.75rem; text-transform: uppercase; margin-bottom: 0.25rem;">${item.label}</div>
            <div style="color: var(--color-text-primary);">${item.value}</div>
        `;
        details.appendChild(detailItem);
    });

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

    // Title field
    const titleGroup = document.createElement('div');
    titleGroup.className = 'form-group';
    titleGroup.innerHTML = '<label>Task Title *</label><input type="text" class="form-control" id="task-title" placeholder="Enter title">';
    body.appendChild(titleGroup);

    // Summary field
    const summaryGroup = document.createElement('div');
    summaryGroup.className = 'form-group';
    summaryGroup.innerHTML = '<label>Summary *</label><input type="text" class="form-control" id="task-summary" placeholder="Brief summary of the task">';
    body.appendChild(summaryGroup);

    // Description field
    const descGroup = document.createElement('div');
    descGroup.className = 'form-group';
    descGroup.innerHTML = '<label>Description</label><textarea class="form-control" id="task-description" rows="3" placeholder="Detailed description (optional)"></textarea>';
    body.appendChild(descGroup);

    // Layer field
    const layerGroup = document.createElement('div');
    layerGroup.className = 'form-group';
    layerGroup.innerHTML = `
        <label>Layer</label>
        <select class="form-control" id="task-layer">
            <option value="DEV" selected>DEV</option>
            <option value="OPS">OPS</option>
            <option value="BIZ">BIZ</option>
            <option value="GOV">GOV</option>
        </select>
    `;
    body.appendChild(layerGroup);

    // Module field
    const moduleGroup = document.createElement('div');
    moduleGroup.className = 'form-group';
    moduleGroup.innerHTML = `
        <label>Module</label>
        <select class="form-control" id="task-module">
            <option value="COMHU" selected>COMHU (Command Hub)</option>
            <option value="OASIS">OASIS</option>
            <option value="GATEWAY">GATEWAY</option>
            <option value="AGENT">AGENT</option>
            <option value="INFRA">INFRA</option>
            <option value="OTHER">OTHER</option>
        </select>
    `;
    body.appendChild(moduleGroup);

    // Status field
    const statusGroup = document.createElement('div');
    statusGroup.className = 'form-group';
    statusGroup.innerHTML = `
        <label>Status</label>
        <select class="form-control" id="task-status">
            <option value="pending" selected>Pending (Scheduled)</option>
            <option value="in_progress">In Progress</option>
            <option value="done">Completed</option>
        </select>
    `;
    body.appendChild(statusGroup);

    modal.appendChild(body);

    // Error banner (hidden by default)
    const errorBanner = document.createElement('div');
    errorBanner.id = 'task-error-banner';
    errorBanner.style.display = 'none';
    errorBanner.style.padding = '0.75rem 1.5rem';
    errorBanner.style.background = 'rgba(239, 68, 68, 0.1)';
    errorBanner.style.borderTop = '1px solid rgba(239, 68, 68, 0.3)';
    errorBanner.style.color = '#ef4444';
    errorBanner.style.fontSize = '0.875rem';
    modal.appendChild(errorBanner);

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
        const title = document.getElementById('task-title').value.trim();
        const summary = document.getElementById('task-summary').value.trim();
        const description = document.getElementById('task-description').value.trim();
        const layer = document.getElementById('task-layer').value;
        const module = document.getElementById('task-module').value;
        const status = document.getElementById('task-status').value;

        // Hide previous error
        errorBanner.style.display = 'none';

        // Basic validation
        if (!title) {
            errorBanner.textContent = 'Title is required';
            errorBanner.style.display = 'block';
            return;
        }

        if (!summary) {
            errorBanner.textContent = 'Summary is required';
            errorBanner.style.display = 'block';
            return;
        }

        // Prepare payload - VTID is NOT sent, backend handles generation
        const payload = {
            layer: layer,
            module: module,
            status: status,
            title: title,
            summary: summary,
            description: description || null,
            assigned_to: null
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
                let errorMsg = 'Unknown error';
                try {
                    const errorData = await response.json();
                    errorMsg = errorData.error || errorData.message || JSON.stringify(errorData);
                } catch (e) {
                    errorMsg = `HTTP ${response.status}: ${response.statusText}`;
                }
                errorBanner.textContent = `Error creating task: ${errorMsg}`;
                errorBanner.style.display = 'block';
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
            errorBanner.textContent = `Failed to create task: ${error.message}`;
            errorBanner.style.display = 'block';
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
        const response = await fetch('/api/v1/oasis/tasks?limit=100');
        if (!response.ok) throw new Error('Network response was not ok');

        const json = await response.json();
        const data = json.data || json;

        state.tasks = (Array.isArray(data) ? data : []).map(item => ({
            id: item.id,
            title: item.title,
            status: item.status, // Raw status, mapped in UI
            vtid: item.vtid,
            summary: item.summary,
            description: item.description,
            layer: item.layer,
            module: item.module,
            assigned_to: item.assigned_to,
            createdAt: item.created_at || item.createdAt // Capture date for filtering
        }));
        state.tasksError = null;
    } catch (error) {
        console.error('Failed to fetch tasks:', error);
        state.tasksError = error.message;
        // No fallback dummy data - show error state instead
        state.tasks = [];
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
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.height = '100%';

    // Toolbar with role filters
    const toolbar = document.createElement('div');
    toolbar.style.padding = '1rem';
    toolbar.style.borderBottom = '1px solid var(--color-border)';
    toolbar.style.display = 'flex';
    toolbar.style.gap = '0.5rem';
    toolbar.style.alignItems = 'center';

    const label = document.createElement('span');
    label.textContent = 'Role:';
    label.style.fontWeight = '600';
    label.style.marginRight = '0.5rem';
    toolbar.appendChild(label);

    const roles = ['DEVELOPER', 'COMMUNITY', 'PATIENT', 'STAFF', 'PROFESSIONAL', 'ADMIN', 'FULL CATALOG'];
    roles.forEach(role => {
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = role;
        if (state.selectedRole === role) {
            btn.style.background = 'var(--color-accent)';
            btn.style.color = '#fff';
        }
        btn.onclick = () => {
            state.selectedRole = role;
            renderApp();
        };
        toolbar.appendChild(btn);
    });

    container.appendChild(toolbar);

    // Content area
    const content = document.createElement('div');
    content.style.flex = '1';
    content.style.overflow = 'auto';
    content.style.padding = '1rem';

    if (state.screenInventoryLoading) {
        content.innerHTML = '<div style=\"padding: 2rem; color: var(--color-text-secondary);\">Loading screen inventory...</div>';
    } else if (state.screenInventoryError) {
        content.innerHTML = `<div style=\"padding: 2rem; color: #ef4444;\">Error: ${state.screenInventoryError}</div>`;
    } else if (!state.screenInventory) {
        content.innerHTML = '<div style=\"padding: 2rem; color: var(--color-text-secondary);\">No screen inventory data available.</div>';
        // Try to fetch it
        fetchScreenInventory();
    } else {
        // Render screen table - support both { modules: [...] } and { screen_inventory: { screens: [...] } } formats
        const modules = state.screenInventory.modules || [];
        const screens = state.screenInventory.screen_inventory?.screens || [];
        const allScreens = screens.length > 0 ? screens : [];

        // If data is loaded but empty (modules.length === 0 or screens.length === 0), show clean empty state
        if (modules.length === 0 && allScreens.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.style.display = 'flex';
            emptyState.style.flexDirection = 'column';
            emptyState.style.alignItems = 'center';
            emptyState.style.justifyContent = 'center';
            emptyState.style.padding = '3rem';
            emptyState.style.color = 'var(--color-text-secondary)';
            emptyState.innerHTML = `
                <div style="font-size: 3rem; margin-bottom: 1rem;">📄</div>
                <div style="font-size: 1.1rem; font-weight: 500; margin-bottom: 0.5rem;">No Screen Inventory Available</div>
                <div style="font-size: 0.9rem; max-width: 400px; text-align: center;">The Dev Screen Inventory spec is empty. Screens will appear here once they are defined in OASIS.</div>
            `;
            content.appendChild(emptyState);
            container.appendChild(content);
            return container;
        }

        const filteredScreens = allScreens.filter(screen => {
            if (state.selectedRole === 'FULL CATALOG') return true;
            return screen.role && screen.role.toUpperCase() === state.selectedRole;
        });

        const summary = document.createElement('div');
        summary.style.marginBottom = '1rem';
        summary.style.padding = '0.5rem 1rem';
        summary.style.background = 'var(--color-sidebar-bg)';
        summary.style.borderRadius = '4px';
        summary.style.fontSize = '0.875rem';
        summary.textContent = `Showing ${filteredScreens.length} screens for ${state.selectedRole}`;
        content.appendChild(summary);

        if (filteredScreens.length === 0) {
            const noMatch = document.createElement('div');
            noMatch.style.padding = '2rem';
            noMatch.style.color = 'var(--color-text-secondary)';
            noMatch.style.textAlign = 'center';
            noMatch.style.fontStyle = 'italic';
            noMatch.textContent = `No screens found for role: ${state.selectedRole}`;
            content.appendChild(noMatch);
        } else {
            const table = document.createElement('table');
            table.style.width = '100%';
            table.style.borderCollapse = 'collapse';
            table.style.fontSize = '0.875rem';

            // Header
            const thead = document.createElement('thead');
            thead.innerHTML = `
                <tr style="background: var(--color-sidebar-bg); text-align: left;">
                    <th style="padding: 0.75rem; border-bottom: 1px solid var(--color-border);">Screen ID</th>
                    <th style="padding: 0.75rem; border-bottom: 1px solid var(--color-border);">Module</th>
                    <th style="padding: 0.75rem; border-bottom: 1px solid var(--color-border);">Tab</th>
                    <th style="padding: 0.75rem; border-bottom: 1px solid var(--color-border);">URL Path</th>
                    <th style="padding: 0.75rem; border-bottom: 1px solid var(--color-border);">Role</th>
                </tr>
            `;
            table.appendChild(thead);

            // Body
            const tbody = document.createElement('tbody');
            filteredScreens.forEach((screen, index) => {
                const tr = document.createElement('tr');
                tr.style.background = index % 2 === 0 ? 'transparent' : 'var(--color-sidebar-bg)';
                tr.innerHTML = `
                    <td style="padding: 0.75rem; border-bottom: 1px solid var(--color-border);">${screen.screen_id || '—'}</td>
                    <td style="padding: 0.75rem; border-bottom: 1px solid var(--color-border);">${screen.module || '—'}</td>
                    <td style="padding: 0.75rem; border-bottom: 1px solid var(--color-border);">${screen.tab || '—'}</td>
                    <td style="padding: 0.75rem; border-bottom: 1px solid var(--color-border);"><code style="background: var(--color-sidebar-bg); padding: 2px 6px; border-radius: 3px;">${screen.url_path || '—'}</code></td>
                    <td style="padding: 0.75rem; border-bottom: 1px solid var(--color-border);">${screen.role || '—'}</td>
                `;
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);

            content.appendChild(table);
        }
    }

    container.appendChild(content);
    return container;
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
    } catch (e) {
        console.error('Critical Render Error:', e);
        document.body.innerHTML = `<div style="color:red; padding:2rem;"><h1>Critical Error</h1><pre>${e.stack}</pre></div>`;
    }
});
