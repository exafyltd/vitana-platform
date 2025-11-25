// =============================================
// VTID-204: Navigation Skeleton (17 modules, 87 screens)
// Extends Golden v4 task board
// =============================================

(function() {
  'use strict';

  // =============================================
  // NAVIGATION CONFIG (from OASIS Spec v1)
  // 17 modules, 87 screens - DO NOT MODIFY ORDER
  // =============================================
  var MODULES = [
    { key: 'overview', label: 'Overview', tabs: ['system-overview', 'live-metrics', 'recent-events', 'errors-violations', 'release-feed'] },
    { key: 'admin', label: 'Admin', tabs: ['users', 'permissions', 'tenants', 'content-moderation', 'identity-access', 'analytics'] },
    { key: 'operator', label: 'Operator', tabs: ['task-queue', 'task-details', 'execution-logs', 'pipelines', 'runbook'] },
    { key: 'command-hub', label: 'Command Hub', tabs: ['tasks', 'live-console', 'events', 'vtids', 'approvals'] },
    { key: 'governance', label: 'Governance', tabs: ['rules', 'categories', 'evaluations', 'violations', 'history', 'proposals'] },
    { key: 'agents', label: 'Agents', tabs: ['registered-agents', 'skills', 'pipelines', 'memory', 'telemetry'] },
    { key: 'workflows', label: 'Workflows', tabs: ['workflow-list', 'triggers', 'actions', 'schedules', 'history'] },
    { key: 'oasis', label: 'OASIS', tabs: ['events', 'vtid-ledger', 'entities', 'streams', 'command-log'] },
    { key: 'databases', label: 'Databases', tabs: ['supabase', 'vectors', 'cache', 'analytics', 'clusters'] },
    { key: 'infrastructure', label: 'Infrastructure', tabs: ['services', 'health', 'deployments', 'logs', 'config'] },
    { key: 'security-dev', label: 'Security (Dev)', tabs: ['policies', 'roles', 'keys-secrets', 'audit-log', 'rls-access'] },
    { key: 'integrations-tools', label: 'Integrations & Tools', tabs: ['mcp-connectors', 'llm-providers', 'apis', 'tools', 'service-mesh'] },
    { key: 'diagnostics', label: 'Diagnostics', tabs: ['health-checks', 'latency', 'errors', 'sse', 'debug-panel'] },
    { key: 'models-evaluations', label: 'Models & Evaluations', tabs: ['models', 'evaluations', 'benchmarks', 'routing', 'playground'] },
    { key: 'testing-qa', label: 'Testing & QA', tabs: ['unit-tests', 'integration-tests', 'validator-tests', 'e2e', 'ci-reports'] },
    { key: 'intelligence-memory-dev', label: 'Intelligence & Memory (Dev)', tabs: ['memory-vault', 'knowledge-graph', 'embeddings', 'recall', 'inspector'] },
    { key: 'docs', label: 'Docs', tabs: ['screens', 'api-inventory', 'database-schemas', 'architecture', 'workforce'] }
  ];

  // Tab labels (human-readable)
  var TAB_LABELS = {
    'system-overview': 'System Overview', 'live-metrics': 'Live Metrics', 'recent-events': 'Recent Events',
    'errors-violations': 'Errors & Violations', 'release-feed': 'Release Feed',
    'users': 'Users', 'permissions': 'Permissions', 'tenants': 'Tenants',
    'content-moderation': 'Content Moderation', 'identity-access': 'Identity & Access', 'analytics': 'Analytics',
    'task-queue': 'Task Queue', 'task-details': 'Task Details', 'execution-logs': 'Execution Logs',
    'pipelines': 'Pipelines', 'runbook': 'Runbook',
    'tasks': 'Tasks', 'live-console': 'Live Console', 'events': 'Events', 'vtids': 'VTIDs', 'approvals': 'Approvals',
    'rules': 'Rules', 'categories': 'Categories', 'evaluations': 'Evaluations',
    'violations': 'Violations', 'history': 'History', 'proposals': 'Proposals',
    'registered-agents': 'Registered Agents', 'skills': 'Skills', 'memory': 'Memory', 'telemetry': 'Telemetry',
    'workflow-list': 'Workflow List', 'triggers': 'Triggers', 'actions': 'Actions', 'schedules': 'Schedules',
    'vtid-ledger': 'VTID Ledger', 'entities': 'Entities', 'streams': 'Streams', 'command-log': 'Command Log',
    'supabase': 'Supabase', 'vectors': 'Vectors', 'cache': 'Cache', 'clusters': 'Clusters',
    'services': 'Services', 'health': 'Health', 'deployments': 'Deployments', 'logs': 'Logs', 'config': 'Config',
    'policies': 'Policies', 'roles': 'Roles', 'keys-secrets': 'Keys & Secrets',
    'audit-log': 'Audit Log', 'rls-access': 'RLS & Access',
    'mcp-connectors': 'MCP Connectors', 'llm-providers': 'LLM Providers', 'apis': 'APIs',
    'tools': 'Tools', 'service-mesh': 'Service Mesh',
    'health-checks': 'Health Checks', 'latency': 'Latency', 'errors': 'Errors', 'sse': 'SSE', 'debug-panel': 'Debug Panel',
    'models': 'Models', 'benchmarks': 'Benchmarks', 'routing': 'Routing', 'playground': 'Playground',
    'unit-tests': 'Unit Tests', 'integration-tests': 'Integration Tests',
    'validator-tests': 'Validator Tests', 'e2e': 'E2E', 'ci-reports': 'CI Reports',
    'memory-vault': 'Memory Vault', 'knowledge-graph': 'Knowledge Graph',
    'embeddings': 'Embeddings', 'recall': 'Recall', 'inspector': 'Inspector',
    'screens': 'Screens', 'api-inventory': 'API Inventory',
    'database-schemas': 'Database Schemas', 'architecture': 'Architecture', 'workforce': 'Workforce'
  };

  // =============================================
  // STATE
  // =============================================
  var state = {
    currentModule: 'command-hub',
    currentTab: 'tasks'
  };

  // =============================================
  // GOLDEN v4: TASK BOARD (preserved)
  // =============================================
  var tasks = [
    { title: "Task A", vtid: "VTID-2025-0001", status: "Scheduled", column: "Scheduled" },
    { title: "Task B", vtid: "VTID-2025-0002", status: "In Progress", column: "In Progress" },
    { title: "Task C", vtid: "VTID-2025-0003", status: "Completed", column: "Completed" },
    { title: "Task D", vtid: "VTID-2025-0004", status: "Scheduled", column: "Scheduled" },
    { title: "Task E", vtid: "VTID-2025-0005", status: "In Progress", column: "In Progress" },
    { title: "Task F", vtid: "VTID-2025-0006", status: "Completed", column: "Completed" }
  ];

  function createTaskCard(task) {
    var card = document.createElement("div");
    card.className = "task-card";
    var title = document.createElement("div");
    title.className = "title";
    title.textContent = task.title;
    var vtid = document.createElement("div");
    vtid.className = "vtid";
    vtid.textContent = task.vtid;
    var status = document.createElement("div");
    status.className = "status";
    status.textContent = task.status;
    card.appendChild(title);
    card.appendChild(vtid);
    card.appendChild(status);
    return card;
  }

  function renderTaskBoard() {
    var board = document.getElementById("taskBoard");
    if (!board) return;
    board.innerHTML = '';

    var columns = [
      { name: "Scheduled", cssClass: "scheduled" },
      { name: "In Progress", cssClass: "in-progress" },
      { name: "Completed", cssClass: "completed" }
    ];

    columns.forEach(function(colDef) {
      var col = document.createElement("div");
      col.className = "task-column " + colDef.cssClass;
      var header = document.createElement("div");
      header.className = "task-column-header";
      header.textContent = colDef.name;
      col.appendChild(header);
      var colTasks = tasks.filter(function(t) { return t.column === colDef.name; });
      colTasks.forEach(function(t) { col.appendChild(createTaskCard(t)); });
      board.appendChild(col);
    });
  }

  // =============================================
  // VTID-204: NAVIGATION
  // =============================================
  function renderSidebar() {
    var sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    sidebar.innerHTML = '';

    MODULES.forEach(function(mod) {
      var item = document.createElement('div');
      item.className = 'sidebar-item';
      if (mod.key === state.currentModule) {
        item.className += ' active';
      }
      item.textContent = mod.label;
      item.setAttribute('data-module', mod.key);
      item.addEventListener('click', function() {
        navigateTo(mod.key, mod.tabs[0]);
      });
      sidebar.appendChild(item);
    });
  }

  function renderTabs() {
    var tabsContainer = document.getElementById('topTabs');
    if (!tabsContainer) return;
    tabsContainer.innerHTML = '';

    var currentMod = MODULES.find(function(m) { return m.key === state.currentModule; });
    if (!currentMod) return;

    currentMod.tabs.forEach(function(tabKey) {
      var tab = document.createElement('div');
      tab.className = 'tab-item';
      if (tabKey === state.currentTab) {
        tab.className += ' active';
      }
      tab.textContent = TAB_LABELS[tabKey] || tabKey;
      tab.setAttribute('data-tab', tabKey);
      tab.addEventListener('click', function() {
        navigateTo(state.currentModule, tabKey);
      });
      tabsContainer.appendChild(tab);
    });
  }

  function renderScreen() {
    var container = document.getElementById('screenContainer');
    var taskBoard = document.getElementById('taskBoard');
    if (!container) return;

    // Show task board only for command-hub/tasks
    if (state.currentModule === 'command-hub' && state.currentTab === 'tasks') {
      if (taskBoard) taskBoard.style.display = '';
      renderTaskBoard();
      return;
    }

    // Hide task board for other screens
    if (taskBoard) taskBoard.style.display = 'none';

    // Generate screen_id
    var screenId = 'DEV_' + state.currentModule.toUpperCase().replace(/-/g, '_') + '_' + state.currentTab.toUpperCase().replace(/-/g, '_');
    var modConfig = MODULES.find(function(m) { return m.key === state.currentModule; });
    var modLabel = modConfig ? modConfig.label : state.currentModule;
    var tabLabel = TAB_LABELS[state.currentTab] || state.currentTab;

    // Render placeholder
    var placeholder = document.createElement('div');
    placeholder.className = 'placeholder-screen';
    placeholder.innerHTML = '<h1>' + modLabel + ' — ' + tabLabel + '</h1>' +
      '<p class="screen-id">screen_id: ' + screenId + '</p>' +
      '<p>Status: Placeholder (VTID-204)</p>';

    // Clear and append
    container.innerHTML = '';
    container.appendChild(placeholder);

    // Re-add task board (hidden) for future navigation
    var newTaskBoard = document.createElement('div');
    newTaskBoard.className = 'task-board';
    newTaskBoard.id = 'taskBoard';
    newTaskBoard.style.display = 'none';
    container.appendChild(newTaskBoard);
  }

  // =============================================
  // ROUTING
  // App is mounted at /command-hub/
  // Routes: /command-hub/<module>/<tab>/
  // =============================================
  var BASE_PATH = '/command-hub';

  function navigateTo(module, tab) {
    state.currentModule = module;
    state.currentTab = tab;

    var path = BASE_PATH + '/' + module + '/' + tab + '/';
    history.pushState({ module: module, tab: tab }, '', path);

    render();
  }

  function parseUrl() {
    var path = window.location.pathname;
    var parts = path.split('/').filter(Boolean);

    // Default to command-hub/tasks
    var module = 'command-hub';
    var tab = 'tasks';

    // Skip 'command-hub' prefix if present
    if (parts[0] === 'command-hub') {
      parts = parts.slice(1);
    }

    if (parts.length >= 2) {
      module = parts[0];
      tab = parts[1];
    } else if (parts.length === 1) {
      module = parts[0];
      var modConfig = MODULES.find(function(m) { return m.key === module; });
      tab = modConfig ? modConfig.tabs[0] : 'tasks';
    }

    // Validate module
    var validMod = MODULES.find(function(m) { return m.key === module; });
    if (!validMod) {
      module = 'command-hub';
      tab = 'tasks';
      validMod = MODULES.find(function(m) { return m.key === module; });
    }

    // Validate tab
    if (validMod.tabs.indexOf(tab) === -1) {
      tab = validMod.tabs[0];
    }

    return { module: module, tab: tab };
  }

  function handlePopState() {
    var parsed = parseUrl();
    state.currentModule = parsed.module;
    state.currentTab = parsed.tab;
    render();
  }

  // =============================================
  // RENDER
  // =============================================
  function render() {
    renderSidebar();
    renderTabs();
    renderScreen();
  }

  // =============================================
  // INIT
  // =============================================
  function init() {
    var parsed = parseUrl();
    state.currentModule = parsed.module;
    state.currentTab = parsed.tab;

    window.addEventListener('popstate', handlePopState);
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
