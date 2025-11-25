/**
 * Vitana Command Hub - Golden v4 Application
 * VTID: DEV-CICDL-0205
 *
 * Features:
 * - 17-module sidebar navigation from OASIS spec
 * - 87-screen inventory with deep linking
 * - SPA routing with history.pushState
 * - Three-column task board (Scheduled/In Progress/Completed)
 * - Task drawer, action popup, role switch modal
 * - Docs module with role filters
 * - CSP compliant - no inline scripts
 */

(function() {
  'use strict';

  // ========================================
  // NAVIGATION CONFIG (17 modules, 87 screens)
  // Built from OASIS spec: /api/v1/oasis/specs/dev-screen-inventory
  // ========================================
  const NAVIGATION_CONFIG = [
    {
      module: 'overview',
      label: 'Overview',
      icon: '\u{1F4CA}',
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
      icon: '\u{1F465}',
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
      icon: '\u{2699}',
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
      icon: '\u{26A1}',
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
      icon: '\u{1F3DB}',
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
      icon: '\u{1F916}',
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
      icon: '\u{1F504}',
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
      icon: '\u{1F4E1}',
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
      icon: '\u{1F5C4}',
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
      icon: '\u{1F5A5}',
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
      icon: '\u{1F512}',
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
      icon: '\u{1F50C}',
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
      icon: '\u{1F9EA}',
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
      icon: '\u{1F9E0}',
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
      icon: '\u{2705}',
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
      icon: '\u{1F4AD}',
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
      icon: '\u{1F4DA}',
      tabs: [
        { key: 'screens', label: 'Screens' },
        { key: 'api-inventory', label: 'API Inventory' },
        { key: 'database-schemas', label: 'Database Schemas' },
        { key: 'architecture', label: 'Architecture' },
        { key: 'workforce', label: 'Workforce' }
      ]
    }
  ];

  // ========================================
  // APPLICATION STATE
  // ========================================
  const state = {
    currentModule: 'command-hub',
    currentTab: 'tasks',
    currentRole: 'DEVELOPER',
    tasks: {
      scheduled: [],
      inProgress: [],
      completed: []
    },
    filters: {
      layer: '',
      search: '',
      role: ''
    },
    screenInventory: []
  };

  // ========================================
  // DOM ELEMENTS
  // ========================================
  const elements = {};

  function cacheElements() {
    elements.sidebar = document.getElementById('sidebar');
    elements.sidebarNav = document.getElementById('sidebarNav');
    elements.sidebarToggle = document.getElementById('sidebarToggle');
    elements.topTabs = document.getElementById('topTabs');
    elements.pageTitle = document.getElementById('pageTitle');
    elements.breadcrumb = document.getElementById('breadcrumb');
    elements.contentArea = document.getElementById('contentArea');
    elements.taskBoardContainer = document.getElementById('taskBoardContainer');
    elements.screenContent = document.getElementById('screenContent');
    elements.taskBoard = document.getElementById('taskBoard');
    elements.tasksScheduled = document.getElementById('tasksScheduled');
    elements.tasksInProgress = document.getElementById('tasksInProgress');
    elements.tasksCompleted = document.getElementById('tasksCompleted');
    elements.countScheduled = document.getElementById('countScheduled');
    elements.countInProgress = document.getElementById('countInProgress');
    elements.countCompleted = document.getElementById('countCompleted');
    elements.filterLayer = document.getElementById('filterLayer');
    elements.searchInput = document.getElementById('searchInput');
    elements.actionBtn = document.getElementById('actionBtn');
    elements.profileCapsule = document.getElementById('profileCapsule');
    elements.userName = document.getElementById('userName');
    elements.userRole = document.getElementById('userRole');
    elements.avatar = document.getElementById('avatar');
    // Drawer
    elements.taskDrawer = document.getElementById('taskDrawer');
    elements.drawerOverlay = document.getElementById('drawerOverlay');
    elements.drawerClose = document.getElementById('drawerClose');
    elements.drawerVtid = document.getElementById('drawerVtid');
    elements.drawerTitle = document.getElementById('drawerTitle');
    elements.drawerContent = document.getElementById('drawerContent');
    elements.copyBriefBtn = document.getElementById('copyBriefBtn');
    elements.viewFullBtn = document.getElementById('viewFullBtn');
    // Action Popup
    elements.actionPopup = document.getElementById('actionPopup');
    elements.actionPopupOverlay = document.getElementById('actionPopupOverlay');
    elements.actionPopupClose = document.getElementById('actionPopupClose');
    // Role Switch Modal
    elements.roleSwitchModal = document.getElementById('roleSwitchModal');
    elements.roleSwitchOverlay = document.getElementById('roleSwitchOverlay');
    elements.roleSwitchClose = document.getElementById('roleSwitchClose');
  }

  // ========================================
  // API LAYER
  // ========================================
  const API = {
    async getTasks(filters) {
      try {
        const params = new URLSearchParams();
        params.append('limit', '100');
        if (filters && filters.status) params.append('status', filters.status);
        if (filters && filters.layer) params.append('taskFamily', filters.layer);

        const response = await fetch('/api/v1/vtid/list?' + params.toString());
        const data = await response.json();
        return data.ok ? data.data : [];
      } catch (error) {
        console.error('[API] getTasks error:', error);
        return [];
      }
    },

    async getTaskDetails(vtid) {
      try {
        const response = await fetch('/api/v1/vtid/' + encodeURIComponent(vtid));
        const data = await response.json();
        return data.ok ? data.data : null;
      } catch (error) {
        console.error('[API] getTaskDetails error:', error);
        return null;
      }
    },

    async getTaskEvents(vtid) {
      try {
        const response = await fetch('/api/v1/events?vtid=' + encodeURIComponent(vtid) + '&limit=20');
        const data = await response.json();
        return data.ok ? data.data : [];
      } catch (error) {
        console.error('[API] getTaskEvents error:', error);
        return [];
      }
    },

    async getScreenInventory() {
      try {
        const response = await fetch('/api/v1/oasis/specs/dev-screen-inventory');
        if (response.ok) {
          return await response.json();
        }
        // Fallback: use local config
        return buildScreenInventoryFromConfig();
      } catch (error) {
        console.error('[API] getScreenInventory error:', error);
        return buildScreenInventoryFromConfig();
      }
    }
  };

  // ========================================
  // BUILD SCREEN INVENTORY FROM CONFIG
  // ========================================
  function buildScreenInventoryFromConfig() {
    const screens = [];
    let screenId = 1;

    NAVIGATION_CONFIG.forEach(function(moduleConfig) {
      moduleConfig.tabs.forEach(function(tab) {
        screens.push({
          screen_id: 'SCR-' + String(screenId).padStart(3, '0'),
          module: moduleConfig.module,
          module_label: moduleConfig.label,
          tab: tab.key,
          tab_label: tab.label,
          url_path: '/command-hub/' + moduleConfig.module + '/' + tab.key + '/',
          role: 'DEVELOPER'
        });
        screenId++;
      });
    });

    return {
      total_screens: screens.length,
      screens: screens
    };
  }

  // ========================================
  // ROUTING
  // ========================================
  const Router = {
    BASE_PATH: '/command-hub',

    init: function() {
      window.addEventListener('popstate', this.handlePopState.bind(this));
      this.navigate(window.location.pathname, false);
    },

    navigate: function(path, pushState) {
      if (pushState === undefined) pushState = true;

      // Ensure path starts with base
      if (!path.startsWith(this.BASE_PATH)) {
        path = this.BASE_PATH + path;
      }

      // Parse the path
      var parsed = this.parsePath(path);
      state.currentModule = parsed.module;
      state.currentTab = parsed.tab;

      // Update URL
      if (pushState) {
        history.pushState({ module: parsed.module, tab: parsed.tab }, '', path);
      }

      // Update UI
      this.updateUI();
    },

    parsePath: function(path) {
      // Remove base path and trailing slash
      var relativePath = path.replace(this.BASE_PATH, '').replace(/^\/|\/$/g, '');
      var parts = relativePath.split('/').filter(Boolean);

      // Default to command-hub/tasks
      var module = 'command-hub';
      var tab = 'tasks';

      if (parts.length >= 1) {
        module = parts[0];
      }
      if (parts.length >= 2) {
        tab = parts[1];
      }

      // Validate module exists
      var moduleConfig = NAVIGATION_CONFIG.find(function(m) { return m.module === module; });
      if (!moduleConfig) {
        module = 'command-hub';
        tab = 'tasks';
        moduleConfig = NAVIGATION_CONFIG.find(function(m) { return m.module === module; });
      }

      // Validate tab exists
      var tabExists = moduleConfig.tabs.some(function(t) { return t.key === tab; });
      if (!tabExists) {
        tab = moduleConfig.tabs[0].key;
      }

      return { module: module, tab: tab };
    },

    handlePopState: function(event) {
      if (event.state) {
        state.currentModule = event.state.module;
        state.currentTab = event.state.tab;
        this.updateUI();
      } else {
        this.navigate(window.location.pathname, false);
      }
    },

    updateUI: function() {
      renderSidebar();
      renderTabs();
      renderContent();
      updateHeader();
    },

    getUrlForScreen: function(module, tab) {
      return this.BASE_PATH + '/' + module + '/' + tab + '/';
    }
  };

  // ========================================
  // RENDER FUNCTIONS
  // ========================================
  function renderSidebar() {
    var html = '';

    NAVIGATION_CONFIG.forEach(function(moduleConfig) {
      var isActive = moduleConfig.module === state.currentModule;
      html += '<div class="nav-item' + (isActive ? ' active' : '') + '" data-module="' + moduleConfig.module + '">' +
        '<span class="nav-icon">' + moduleConfig.icon + '</span>' +
        '<span class="nav-label">' + moduleConfig.label + '</span>' +
        '</div>';
    });

    elements.sidebarNav.innerHTML = html;

    // Add click handlers
    var navItems = elements.sidebarNav.querySelectorAll('.nav-item');
    navItems.forEach(function(item) {
      item.addEventListener('click', function() {
        var module = this.getAttribute('data-module');
        var moduleConfig = NAVIGATION_CONFIG.find(function(m) { return m.module === module; });
        var defaultTab = moduleConfig.tabs[0].key;
        Router.navigate(Router.getUrlForScreen(module, defaultTab));
      });
    });
  }

  function renderTabs() {
    var moduleConfig = NAVIGATION_CONFIG.find(function(m) { return m.module === state.currentModule; });
    if (!moduleConfig) return;

    var html = '';
    moduleConfig.tabs.forEach(function(tab) {
      var isActive = tab.key === state.currentTab;
      html += '<div class="tab-item' + (isActive ? ' active' : '') + '" data-tab="' + tab.key + '">' +
        tab.label +
        '</div>';
    });

    elements.topTabs.innerHTML = html;

    // Add click handlers
    var tabItems = elements.topTabs.querySelectorAll('.tab-item');
    tabItems.forEach(function(item) {
      item.addEventListener('click', function() {
        var tab = this.getAttribute('data-tab');
        Router.navigate(Router.getUrlForScreen(state.currentModule, tab));
      });
    });
  }

  function renderContent() {
    // Show task board only for command-hub/tasks
    if (state.currentModule === 'command-hub' && state.currentTab === 'tasks') {
      elements.taskBoardContainer.style.display = '';
      elements.screenContent.style.display = 'none';
      loadTasks();
    } else if (state.currentModule === 'docs' && state.currentTab === 'screens') {
      // Show docs screen inventory
      elements.taskBoardContainer.style.display = 'none';
      elements.screenContent.style.display = '';
      renderDocsScreenInventory();
    } else {
      // Show placeholder for other screens
      elements.taskBoardContainer.style.display = 'none';
      elements.screenContent.style.display = '';
      renderPlaceholderScreen();
    }
  }

  function updateHeader() {
    var moduleConfig = NAVIGATION_CONFIG.find(function(m) { return m.module === state.currentModule; });
    var tabConfig = moduleConfig ? moduleConfig.tabs.find(function(t) { return t.key === state.currentTab; }) : null;

    elements.pageTitle.textContent = moduleConfig ? moduleConfig.label : 'Command Hub';
    elements.breadcrumb.textContent = tabConfig ? tabConfig.label : '';
  }

  function renderPlaceholderScreen() {
    var moduleConfig = NAVIGATION_CONFIG.find(function(m) { return m.module === state.currentModule; });
    var tabConfig = moduleConfig ? moduleConfig.tabs.find(function(t) { return t.key === state.currentTab; }) : null;

    elements.screenContent.innerHTML =
      '<div class="empty-state">' +
      '<div class="empty-icon">' + (moduleConfig ? moduleConfig.icon : '\u{1F4CB}') + '</div>' +
      '<div class="empty-text">' + (tabConfig ? tabConfig.label : 'Screen') + ' - Coming Soon</div>' +
      '<div style="margin-top: 1rem; color: var(--text-muted); font-size: 0.875rem;">' +
      'Route: /command-hub/' + state.currentModule + '/' + state.currentTab + '/' +
      '</div>' +
      '</div>';
  }

  // ========================================
  // TASK BOARD
  // ========================================
  async function loadTasks() {
    try {
      var allTasks = await API.getTasks(state.filters);

      // Categorize tasks by status
      state.tasks.scheduled = allTasks.filter(function(t) {
        return t.status === 'pending' || t.status === 'scheduled';
      });
      state.tasks.inProgress = allTasks.filter(function(t) {
        return t.status === 'active' || t.status === 'in_progress';
      });
      state.tasks.completed = allTasks.filter(function(t) {
        return t.status === 'complete' || t.status === 'completed';
      });

      renderTaskBoard();
    } catch (error) {
      console.error('[Tasks] Load error:', error);
      renderTaskBoard();
    }
  }

  function renderTaskBoard() {
    // Apply filters
    var scheduled = applyTaskFilters(state.tasks.scheduled);
    var inProgress = applyTaskFilters(state.tasks.inProgress);
    var completed = applyTaskFilters(state.tasks.completed);

    // Update counts
    elements.countScheduled.textContent = scheduled.length;
    elements.countInProgress.textContent = inProgress.length;
    elements.countCompleted.textContent = completed.length;

    // Render columns
    elements.tasksScheduled.innerHTML = renderTaskColumn(scheduled, 'scheduled');
    elements.tasksInProgress.innerHTML = renderTaskColumn(inProgress, 'in-progress');
    elements.tasksCompleted.innerHTML = renderTaskColumn(completed, 'completed');

    // Add click handlers to task cards
    var cards = elements.taskBoard.querySelectorAll('.task-card');
    cards.forEach(function(card) {
      card.addEventListener('click', function() {
        var vtid = this.getAttribute('data-vtid');
        openTaskDrawer(vtid);
      });
    });
  }

  function renderTaskColumn(tasks, column) {
    if (!tasks.length) {
      return '<div class="empty-state"><div class="empty-icon">\u{1F4CB}</div><div class="empty-text">No tasks</div></div>';
    }

    var html = '';
    tasks.forEach(function(task) {
      var priority = (task.metadata && task.metadata.priority) || 'P2';
      var title = task.description || task.task_type || 'Untitled Task';
      var time = formatRelativeTime(new Date(task.updated_at));

      html += '<div class="task-card" data-vtid="' + escapeHtml(task.vtid) + '">' +
        '<div class="task-card-header">' +
        '<span class="task-vtid">' + escapeHtml(task.vtid) + '</span>' +
        '<span class="task-priority ' + priority.toLowerCase() + '">' + priority + '</span>' +
        '</div>' +
        '<div class="task-title">' + escapeHtml(title) + '</div>' +
        '<div class="task-meta">' +
        '<span class="task-meta-item">\u{1F550} ' + time + '</span>' +
        '</div>' +
        '</div>';
    });

    return html;
  }

  function applyTaskFilters(tasks) {
    return tasks.filter(function(task) {
      // Layer filter
      if (state.filters.layer) {
        var layer = extractLayer(task.vtid);
        if (layer !== state.filters.layer) return false;
      }

      // Search filter
      if (state.filters.search) {
        var searchLower = state.filters.search.toLowerCase();
        var haystack = (task.vtid + ' ' + task.description + ' ' + task.task_type).toLowerCase();
        if (haystack.indexOf(searchLower) === -1) return false;
      }

      return true;
    });
  }

  function extractLayer(vtid) {
    var parts = vtid.split('-');
    return parts[1] || 'UNKNOWN';
  }

  // ========================================
  // TASK DRAWER
  // ========================================
  async function openTaskDrawer(vtid) {
    elements.taskDrawer.classList.add('open');
    elements.drawerOverlay.classList.add('open');

    elements.drawerVtid.textContent = vtid;
    elements.drawerTitle.textContent = 'Loading...';
    elements.drawerContent.innerHTML = '<div class="loading"><div class="loading-spinner"></div>Loading task details...</div>';

    try {
      var task = await API.getTaskDetails(vtid);
      var events = await API.getTaskEvents(vtid);

      if (task) {
        renderTaskDrawer(task, events);
        // Store current task for copy brief
        elements.taskDrawer.dataset.currentTask = JSON.stringify(task);
      } else {
        elements.drawerContent.innerHTML = '<div class="empty-state"><div class="empty-text">Task not found</div></div>';
      }
    } catch (error) {
      console.error('[Drawer] Error:', error);
      elements.drawerContent.innerHTML = '<div class="empty-state"><div class="empty-text">Error loading task</div></div>';
    }
  }

  function renderTaskDrawer(task, events) {
    elements.drawerTitle.textContent = task.description || task.task_type || 'Task Details';

    var priority = (task.metadata && task.metadata.priority) || 'P2';
    var layer = extractLayer(task.vtid);
    var owner = task.assigned_to || 'Unassigned';

    var html = '<div class="drawer-section">' +
      '<div class="section-title">Details</div>' +
      '<div class="info-grid">' +
      '<div class="info-item"><div class="info-label">Status</div><div class="info-value">' + escapeHtml(task.status) + '</div></div>' +
      '<div class="info-item"><div class="info-label">Priority</div><div class="info-value">' + priority + '</div></div>' +
      '<div class="info-item"><div class="info-label">Layer</div><div class="info-value">' + layer + '</div></div>' +
      '<div class="info-item"><div class="info-label">Owner</div><div class="info-value">' + escapeHtml(owner) + '</div></div>' +
      '</div></div>';

    // Timeline
    if (events && events.length) {
      html += '<div class="drawer-section"><div class="section-title">Timeline</div>';
      events.forEach(function(ev) {
        var time = formatDateTime(new Date(ev.created_at));
        html += '<div class="timeline-item">' +
          '<div class="timeline-dot"></div>' +
          '<div class="timeline-content">' +
          '<div class="timeline-header">' +
          '<span class="timeline-event">' + escapeHtml(ev.event_type || ev.topic || 'Event') + '</span>' +
          '<span class="timeline-time">' + time + '</span>' +
          '</div>' +
          '<div class="timeline-message">' + escapeHtml(ev.message || ev.notes || '') + '</div>' +
          '</div></div>';
      });
      html += '</div>';
    }

    // Specification
    html += '<div class="drawer-section">' +
      '<div class="section-title">Specification</div>' +
      '<div class="info-item"><div class="info-label">Task Family</div><div class="info-value">' + escapeHtml(task.task_family || '-') + '</div></div>' +
      '<div class="info-item" style="margin-top: 0.75rem"><div class="info-label">Task Type</div><div class="info-value">' + escapeHtml(task.task_type || '-') + '</div></div>' +
      '<div class="info-item" style="margin-top: 0.75rem"><div class="info-label">Description</div><div class="info-value">' + escapeHtml(task.description || '-') + '</div></div>' +
      '</div>';

    elements.drawerContent.innerHTML = html;
  }

  function closeTaskDrawer() {
    elements.taskDrawer.classList.remove('open');
    elements.drawerOverlay.classList.remove('open');
  }

  async function copyTaskBrief() {
    try {
      var taskData = elements.taskDrawer.dataset.currentTask;
      if (!taskData) return;

      var task = JSON.parse(taskData);
      var brief = 'VTID: ' + task.vtid + '\n' +
        'Task Family: ' + (task.task_family || '-') + '\n' +
        'Task Type: ' + (task.task_type || '-') + '\n' +
        'Status: ' + task.status + '\n' +
        'Priority: ' + ((task.metadata && task.metadata.priority) || 'P2') + '\n' +
        'Assigned To: ' + (task.assigned_to || 'Unassigned') + '\n\n' +
        'Description:\n' + (task.description || '-');

      await navigator.clipboard.writeText(brief);
      alert('Task brief copied to clipboard!');
    } catch (error) {
      console.error('[CopyBrief] Error:', error);
    }
  }

  // ========================================
  // ACTION POPUP
  // ========================================
  function openActionPopup() {
    elements.actionPopup.classList.add('open');
    elements.actionPopupOverlay.classList.add('open');
  }

  function closeActionPopup() {
    elements.actionPopup.classList.remove('open');
    elements.actionPopupOverlay.classList.remove('open');
  }

  function handlePopupAction(action) {
    closeActionPopup();

    switch (action) {
      case 'create-vtid':
        alert('Create VTID - Feature coming soon');
        break;
      case 'run-validator':
        alert('Run Validator - Feature coming soon');
        break;
      case 'view-events':
        Router.navigate('/command-hub/oasis/events/');
        break;
      case 'open-docs':
        Router.navigate('/command-hub/docs/screens/');
        break;
    }
  }

  // ========================================
  // ROLE SWITCH MODAL
  // ========================================
  function openRoleSwitchModal() {
    elements.roleSwitchModal.classList.add('open');
    elements.roleSwitchOverlay.classList.add('open');
    updateRoleOptions();
  }

  function closeRoleSwitchModal() {
    elements.roleSwitchModal.classList.remove('open');
    elements.roleSwitchOverlay.classList.remove('open');
  }

  function updateRoleOptions() {
    var options = elements.roleSwitchModal.querySelectorAll('.role-option');
    options.forEach(function(option) {
      var role = option.getAttribute('data-role');
      if (role === state.currentRole) {
        option.classList.add('active');
      } else {
        option.classList.remove('active');
      }
    });
  }

  function switchRole(role) {
    state.currentRole = role;
    elements.userRole.textContent = role;
    elements.userName.textContent = role.charAt(0) + role.slice(1).toLowerCase();
    elements.avatar.textContent = role.charAt(0);
    closeRoleSwitchModal();

    // Refresh content if on docs screens
    if (state.currentModule === 'docs' && state.currentTab === 'screens') {
      renderDocsScreenInventory();
    }
  }

  // ========================================
  // DOCS SCREEN INVENTORY
  // ========================================
  async function renderDocsScreenInventory() {
    elements.screenContent.innerHTML = '<div class="loading"><div class="loading-spinner"></div>Loading screen inventory...</div>';

    try {
      var inventory = await API.getScreenInventory();
      state.screenInventory = inventory.screens || [];

      renderDocsTable();
    } catch (error) {
      console.error('[Docs] Error:', error);
      elements.screenContent.innerHTML = '<div class="empty-state"><div class="empty-text">Error loading screen inventory</div></div>';
    }
  }

  function renderDocsTable() {
    var filteredScreens = state.screenInventory;

    // Apply role filter
    if (state.filters.role) {
      filteredScreens = filteredScreens.filter(function(screen) {
        return screen.role === state.filters.role;
      });
    }

    // Count by role
    var roleCount = {};
    state.screenInventory.forEach(function(screen) {
      roleCount[screen.role] = (roleCount[screen.role] || 0) + 1;
    });

    var html = '<div class="docs-container">' +
      '<div class="docs-header">' +
      '<h2 class="docs-title">Screen Inventory</h2>' +
      '<div class="docs-filters">' +
      '<select class="filter-select" id="docsRoleFilter">' +
      '<option value="">All Roles</option>' +
      '<option value="DEVELOPER"' + (state.filters.role === 'DEVELOPER' ? ' selected' : '') + '>Developer</option>' +
      '<option value="ADMIN"' + (state.filters.role === 'ADMIN' ? ' selected' : '') + '>Admin</option>' +
      '<option value="STAFF"' + (state.filters.role === 'STAFF' ? ' selected' : '') + '>Staff</option>' +
      '<option value="OPERATOR"' + (state.filters.role === 'OPERATOR' ? ' selected' : '') + '>Operator</option>' +
      '</select>' +
      '</div>' +
      '</div>' +
      '<div class="docs-stats">' +
      '<div class="stat-item"><span class="stat-label">Total Screens</span><span class="stat-value">' + state.screenInventory.length + '</span></div>' +
      '<div class="stat-item"><span class="stat-label">Modules</span><span class="stat-value">17</span></div>' +
      '<div class="stat-item"><span class="stat-label">Filtered</span><span class="stat-value">' + filteredScreens.length + '</span></div>' +
      '</div>' +
      '<div class="docs-table-container">' +
      '<table class="docs-table">' +
      '<thead><tr>' +
      '<th>Screen ID</th>' +
      '<th>Module</th>' +
      '<th>Tab</th>' +
      '<th>URL Path</th>' +
      '<th>Role</th>' +
      '</tr></thead>' +
      '<tbody>';

    filteredScreens.forEach(function(screen) {
      var roleClass = screen.role.toLowerCase();
      html += '<tr>' +
        '<td>' + escapeHtml(screen.screen_id) + '</td>' +
        '<td>' + escapeHtml(screen.module_label || screen.module) + '</td>' +
        '<td><a href="#" class="screen-link" data-module="' + escapeHtml(screen.module) + '" data-tab="' + escapeHtml(screen.tab) + '">' + escapeHtml(screen.tab_label || screen.tab) + '</a></td>' +
        '<td><code>' + escapeHtml(screen.url_path) + '</code></td>' +
        '<td><span class="role-badge ' + roleClass + '">' + escapeHtml(screen.role) + '</span></td>' +
        '</tr>';
    });

    html += '</tbody></table></div></div>';

    elements.screenContent.innerHTML = html;

    // Add event listeners
    var roleFilter = document.getElementById('docsRoleFilter');
    if (roleFilter) {
      roleFilter.addEventListener('change', function() {
        state.filters.role = this.value;
        renderDocsTable();
      });
    }

    var screenLinks = elements.screenContent.querySelectorAll('.screen-link');
    screenLinks.forEach(function(link) {
      link.addEventListener('click', function(e) {
        e.preventDefault();
        var module = this.getAttribute('data-module');
        var tab = this.getAttribute('data-tab');
        Router.navigate(Router.getUrlForScreen(module, tab));
      });
    });
  }

  // ========================================
  // UTILITY FUNCTIONS
  // ========================================
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatRelativeTime(date) {
    var now = new Date();
    var diff = now - date;
    var mins = Math.floor(diff / 60000);
    var hours = Math.floor(diff / 3600000);
    var days = Math.floor(diff / 86400000);

    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (hours < 24) return hours + 'h ago';
    return days + 'd ago';
  }

  function formatDateTime(date) {
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // ========================================
  // EVENT LISTENERS
  // ========================================
  function setupEventListeners() {
    // Sidebar toggle
    elements.sidebarToggle.addEventListener('click', function() {
      elements.sidebar.classList.toggle('collapsed');
    });

    // Task filters
    elements.filterLayer.addEventListener('change', function() {
      state.filters.layer = this.value;
      if (state.currentModule === 'command-hub' && state.currentTab === 'tasks') {
        renderTaskBoard();
      }
    });

    elements.searchInput.addEventListener('input', function() {
      state.filters.search = this.value;
      if (state.currentModule === 'command-hub' && state.currentTab === 'tasks') {
        renderTaskBoard();
      }
    });

    // Action button
    elements.actionBtn.addEventListener('click', openActionPopup);
    elements.actionPopupClose.addEventListener('click', closeActionPopup);
    elements.actionPopupOverlay.addEventListener('click', closeActionPopup);

    // Popup actions
    var popupActions = document.querySelectorAll('.popup-action');
    popupActions.forEach(function(btn) {
      btn.addEventListener('click', function() {
        var action = this.getAttribute('data-action');
        handlePopupAction(action);
      });
    });

    // Profile capsule / Role switch
    elements.profileCapsule.addEventListener('click', openRoleSwitchModal);
    elements.roleSwitchClose.addEventListener('click', closeRoleSwitchModal);
    elements.roleSwitchOverlay.addEventListener('click', closeRoleSwitchModal);

    // Role options
    var roleOptions = document.querySelectorAll('.role-option');
    roleOptions.forEach(function(option) {
      option.addEventListener('click', function() {
        var role = this.getAttribute('data-role');
        switchRole(role);
      });
    });

    // Drawer
    elements.drawerClose.addEventListener('click', closeTaskDrawer);
    elements.drawerOverlay.addEventListener('click', closeTaskDrawer);
    elements.copyBriefBtn.addEventListener('click', copyTaskBrief);
    elements.viewFullBtn.addEventListener('click', function() {
      alert('View Full - Feature coming soon');
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        if (elements.taskDrawer.classList.contains('open')) {
          closeTaskDrawer();
        }
        if (elements.actionPopup.classList.contains('open')) {
          closeActionPopup();
        }
        if (elements.roleSwitchModal.classList.contains('open')) {
          closeRoleSwitchModal();
        }
      }
    });
  }

  // ========================================
  // INITIALIZATION
  // ========================================
  function init() {
    cacheElements();
    setupEventListeners();
    Router.init();
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
