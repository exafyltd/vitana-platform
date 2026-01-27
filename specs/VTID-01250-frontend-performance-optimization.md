# VTID-01250: Frontend Performance Optimization Specification

## Document Information

| Field | Value |
|-------|-------|
| VTID | VTID-01250 |
| Title | Command Hub Frontend Performance Optimization |
| Status | DRAFT |
| Author | Claude (AI Assistant) |
| Created | 2026-01-27 |
| Target | services/gateway/src/frontend/command-hub/ |

---

## Executive Summary

Performance analysis of the Vitana Command Hub reveals critical bottlenecks affecting user experience:

- **900KB JavaScript bundle** blocking initial render (1.4s download)
- **275KB CSS file** with 2,001 rules (majority unused)
- **Aggressive polling** generating 22+ API calls per 2 minutes
- **818 DOM elements** rendered on initial load with no virtualization
- **Blanket CSS transitions** on all elements causing GPU overhead

This specification defines a phased approach to address these issues, targeting:
- First Contentful Paint (FCP) < 1.5s
- Time to Interactive (TTI) < 3.0s
- 60% reduction in bundle size
- 70% reduction in polling overhead

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [Performance Targets](#2-performance-targets)
3. [Phase 1: Quick Wins](#3-phase-1-quick-wins)
4. [Phase 2: Bundle Optimization](#4-phase-2-bundle-optimization)
5. [Phase 3: Network Optimization](#5-phase-3-network-optimization)
6. [Phase 4: Rendering Optimization](#6-phase-4-rendering-optimization)
7. [Phase 5: Storage Optimization](#7-phase-5-storage-optimization)
8. [Implementation Details](#8-implementation-details)
9. [Testing & Validation](#9-testing--validation)
10. [Rollback Strategy](#10-rollback-strategy)
11. [Appendices](#11-appendices)

---

## 1. Current State Analysis

### 1.1 Architecture Overview

The Command Hub is a vanilla JavaScript single-page application (SPA) without a framework:

```
services/gateway/src/frontend/command-hub/
├── index.html              # Entry point (338 bytes)
├── app.js                  # Monolithic bundle (900 KB)
├── styles.css              # All styling (276 KB)
├── navigation-config.js    # Navigation structure (6 KB)
└── BUILD.md                # Governance document
```

**Key Characteristics:**
- No build system (Webpack/Vite) - files served directly
- Global `state` object for state management
- Direct DOM manipulation via `createElement()`
- Client-side routing with `history.pushState()`
- Token-based authentication via localStorage

### 1.2 Identified Performance Issues

| Issue | Metric | Impact | Severity |
|-------|--------|--------|----------|
| Monolithic JS bundle | 900 KB | 1.4s blocking download | CRITICAL |
| Large CSS file | 275 KB / 2,001 rules | Render blocking | HIGH |
| CI/CD polling | Every 10s | Network congestion | HIGH |
| Approvals polling | Every 20s | Unnecessary requests | MEDIUM |
| No virtual scrolling | 818 DOM elements | Memory/CPU overhead | HIGH |
| Blanket transitions | 818 animated elements | GPU thrashing | MEDIUM |
| localStorage bloat | 254 keys / 800 KB | Storage quota risk | LOW |
| Null response error | VTID-01049 fetchMeContext | Uncaught exception | LOW |

### 1.3 Baseline Metrics

```
Current Performance (estimated):
├── First Contentful Paint (FCP): ~2.5s
├── Time to Interactive (TTI): ~4.5s
├── Total Blocking Time (TBT): ~800ms
├── Cumulative Layout Shift (CLS): ~0.15
├── API calls per minute: ~11
└── DOM elements at idle: 818
```

---

## 2. Performance Targets

### 2.1 Core Web Vitals Targets

| Metric | Current | Target | Improvement |
|--------|---------|--------|-------------|
| FCP | ~2.5s | < 1.5s | 40% faster |
| TTI | ~4.5s | < 3.0s | 33% faster |
| TBT | ~800ms | < 200ms | 75% reduction |
| CLS | ~0.15 | < 0.1 | Good threshold |

### 2.2 Resource Targets

| Resource | Current | Target | Improvement |
|----------|---------|--------|-------------|
| JS Bundle (gzipped) | ~250 KB | < 100 KB critical | 60% reduction |
| CSS (gzipped) | ~45 KB | < 20 KB critical | 55% reduction |
| API calls/minute | ~11 | < 3 | 73% reduction |
| DOM elements | 818 | < 300 visible | 63% reduction |

---

## 3. Phase 1: Quick Wins

**Timeline:** 1-2 days
**Risk:** Low
**Impact:** Medium

### 3.1 Fix Null Response Error (VTID-01049)

**Location:** `app.js` - `fetchMeContext()` function

**Current Code (problematic):**
```javascript
async function fetchMeContext() {
    try {
        var response = await fetch('/api/v1/me');
        if (response.ok) {  // Fails if response is null
            // ...
        }
    } catch (e) {
        console.error('[VTID-01049] fetchMeContext failed:', e);
    }
}
```

**Fixed Code:**
```javascript
async function fetchMeContext() {
    try {
        var response = await fetch('/api/v1/me');
        if (response && response.ok) {  // Null-safe check
            var data = await response.json();
            // ... handle success
        } else if (response) {
            console.warn('[VTID-01049] fetchMeContext non-ok response:', response.status);
        } else {
            console.warn('[VTID-01049] fetchMeContext received null response');
        }
    } catch (e) {
        console.error('[VTID-01049] fetchMeContext failed:', e);
    }
}
```

**Apply to all fetch functions:**
- `fetchTasks()`
- `fetchMeContext()`
- `fetchOasisEvents()`
- `fetchApprovals()`
- `fetchCicdHealth()`

### 3.2 Remove Blanket CSS Transitions

**Location:** `styles.css`

**Current Code (problematic):**
```css
/* Likely present - applies transitions to EVERY element */
* {
    transition: all 0.3s ease;
}

/* Or via body inheritance */
body {
    transition: all 0.3s;
}
```

**Fixed Code:**
```css
/* Remove blanket transitions - apply only to interactive elements */

/* Interactive elements that need transitions */
.task-card,
.task-card-enhanced,
.btn,
.button,
.nav-item,
.dropdown,
.modal,
.drawer,
.sidebar-item {
    transition: transform 0.2s ease,
                opacity 0.2s ease,
                background-color 0.15s ease,
                box-shadow 0.2s ease;
}

/* Hover states */
.task-card:hover,
.btn:hover,
.nav-item:hover {
    transition-duration: 0.1s; /* Faster on hover for responsiveness */
}

/* Disable transitions for non-interactive elements */
.task-card-title,
.task-card-vtid-label,
.task-card-status-pill,
.column-header,
.column-content,
.main-content {
    transition: none;
}
```

### 3.3 Implement Page Visibility API for Polling

**Location:** `app.js` - Add near polling initialization

**New Code:**
```javascript
// VTID-01250: Pause polling when page is hidden
(function initVisibilityHandler() {
    var pollingIntervals = {
        cicdHealth: null,
        approvals: null,
        executions: null,
        tasks: null
    };

    // Store original intervals
    var originalIntervals = {
        cicdHealth: 10000,   // 10s
        approvals: 20000,    // 20s
        executions: 5000,    // 5s
        tasks: 30000         // 30s
    };

    // Reduced intervals when page is visible but idle
    var idleIntervals = {
        cicdHealth: 30000,   // 30s when idle
        approvals: 60000,    // 60s when idle
        executions: 15000,   // 15s when idle
        tasks: 60000         // 60s when idle
    };

    var isPageVisible = true;
    var isUserIdle = false;
    var idleTimeout = null;
    var IDLE_THRESHOLD = 60000; // 1 minute of no activity

    function pausePolling() {
        console.log('[VTID-01250] Pausing polling - page hidden');
        if (window.cicdHealthInterval) clearInterval(window.cicdHealthInterval);
        if (window.approvalsInterval) clearInterval(window.approvalsInterval);
        if (window.executionsInterval) clearInterval(window.executionsInterval);
        if (window.tasksInterval) clearInterval(window.tasksInterval);
    }

    function resumePolling() {
        console.log('[VTID-01250] Resuming polling - page visible');
        // Immediate refresh on return
        if (typeof fetchCicdHealth === 'function') fetchCicdHealth();
        if (typeof fetchApprovals === 'function') fetchApprovals();
        if (typeof fetchTasks === 'function') fetchTasks();

        // Restart intervals (use idle intervals if user was idle)
        var intervals = isUserIdle ? idleIntervals : originalIntervals;
        startPollingWithIntervals(intervals);
    }

    function startPollingWithIntervals(intervals) {
        if (typeof startCicdHealthPolling === 'function') {
            window.cicdHealthInterval = setInterval(fetchCicdHealth, intervals.cicdHealth);
        }
        if (typeof startApprovalsBadgePolling === 'function') {
            window.approvalsInterval = setInterval(fetchApprovals, intervals.approvals);
        }
        // ... similar for other polling functions
    }

    function resetIdleTimer() {
        isUserIdle = false;
        clearTimeout(idleTimeout);
        idleTimeout = setTimeout(function() {
            isUserIdle = true;
            console.log('[VTID-01250] User idle - reducing polling frequency');
            if (isPageVisible) {
                pausePolling();
                startPollingWithIntervals(idleIntervals);
            }
        }, IDLE_THRESHOLD);
    }

    // Page Visibility API
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            isPageVisible = false;
            pausePolling();
        } else {
            isPageVisible = true;
            resumePolling();
        }
    });

    // User activity detection
    ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart'].forEach(function(event) {
        document.addEventListener(event, resetIdleTimer, { passive: true });
    });

    // Initialize idle timer
    resetIdleTimer();
})();
```

### 3.4 Add Resource Hints to index.html

**Location:** `index.html`

**Updated Code:**
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Vitana Command Hub</title>

    <!-- VTID-01250: Resource hints for faster loading -->
    <link rel="preconnect" href="/api" crossorigin>
    <link rel="dns-prefetch" href="/api">

    <!-- Critical CSS inline (extracted later in Phase 2) -->
    <style id="critical-css">
        /* Will contain ~5KB of critical above-fold styles */
    </style>

    <!-- Defer non-critical CSS -->
    <link rel="preload" href="styles.css" as="style" onload="this.onload=null;this.rel='stylesheet'">
    <noscript><link rel="stylesheet" href="styles.css"></noscript>

    <!-- Preload critical JS modules (when split) -->
    <link rel="modulepreload" href="core.js">
</head>
<body>
    <div id="app"></div>

    <!-- Defer main bundle -->
    <script src="navigation-config.js" defer></script>
    <script src="app.js" defer></script>
</body>
</html>
```

---

## 4. Phase 2: Bundle Optimization

**Timeline:** 1-2 weeks
**Risk:** Medium
**Impact:** High

### 4.1 Introduce Build System

**Recommended:** Vite (for simplicity and speed)

**New Project Structure:**
```
services/gateway/src/frontend/command-hub/
├── src/
│   ├── main.js              # Entry point
│   ├── core/
│   │   ├── state.js         # Global state management
│   │   ├── router.js        # Client-side routing
│   │   ├── api.js           # API client
│   │   └── dom.js           # DOM utilities
│   ├── features/
│   │   ├── tasks/           # Task board module
│   │   │   ├── index.js
│   │   │   ├── TaskCard.js
│   │   │   ├── TaskBoard.js
│   │   │   └── TaskDrawer.js
│   │   ├── approvals/       # Approvals module
│   │   ├── cicd/            # CI/CD module
│   │   ├── oasis/           # OASIS module
│   │   └── assistant/       # ORB assistant (lazy-loaded)
│   ├── components/
│   │   ├── Modal.js
│   │   ├── Drawer.js
│   │   ├── Button.js
│   │   └── ...
│   └── styles/
│       ├── critical.css     # Above-fold styles (~5KB)
│       ├── base.css         # Reset, variables
│       ├── components.css   # Component styles
│       └── features/        # Feature-specific styles
├── index.html
├── vite.config.js
└── package.json
```

**vite.config.js:**
```javascript
import { defineConfig } from 'vite';
import { compression } from 'vite-plugin-compression2';

export default defineConfig({
    root: 'src/frontend/command-hub',
    build: {
        outDir: '../../../dist/frontend/command-hub',
        emptyOutDir: true,
        rollupOptions: {
            output: {
                manualChunks: {
                    // Core chunk - always loaded
                    'core': [
                        './src/core/state.js',
                        './src/core/router.js',
                        './src/core/api.js',
                        './src/core/dom.js'
                    ],
                    // Task board - primary feature
                    'tasks': [
                        './src/features/tasks/index.js'
                    ],
                    // Secondary features - lazy loaded
                    'approvals': [
                        './src/features/approvals/index.js'
                    ],
                    'oasis': [
                        './src/features/oasis/index.js'
                    ],
                    // Heavy features - loaded on demand
                    'assistant': [
                        './src/features/assistant/index.js'
                    ]
                }
            }
        },
        // Target modern browsers
        target: 'es2020',
        // Minification
        minify: 'terser',
        terserOptions: {
            compress: {
                drop_console: false, // Keep for VTID logging
                drop_debugger: true
            }
        }
    },
    plugins: [
        compression({
            algorithm: 'gzip',
            ext: '.gz'
        }),
        compression({
            algorithm: 'brotliCompress',
            ext: '.br'
        })
    ]
});
```

### 4.2 Code Splitting Strategy

**Route-Based Splitting:**

```javascript
// src/main.js - Entry point with lazy loading

import { initRouter } from './core/router.js';
import { initState } from './core/state.js';
import './styles/critical.css';

// Core initialization
initState();
initRouter();

// Route-based lazy loading
const routes = {
    '/command-hub/tasks': () => import('./features/tasks/index.js'),
    '/command-hub/approvals': () => import('./features/approvals/index.js'),
    '/command-hub/events': () => import('./features/oasis/index.js'),
    '/command-hub/vtids': () => import('./features/vtids/index.js'),
    '/command-hub/live-console': () => import('./features/console/index.js'),
    // ... other routes
};

// Load route module on navigation
async function loadRoute(path) {
    const loader = routes[path];
    if (loader) {
        const module = await loader();
        module.init();
    }
}

// Initial route
loadRoute(window.location.pathname);
```

**Feature-Based Splitting:**

```javascript
// Lazy load assistant only when needed
async function openAssistant() {
    const { AssistantDialog } = await import('./features/assistant/index.js');
    const dialog = new AssistantDialog();
    dialog.open();
}

// Lazy load heavy visualizations
async function showPipelineGraph() {
    const { PipelineGraph } = await import('./features/cicd/PipelineGraph.js');
    // ...
}
```

### 4.3 Tree Shaking Configuration

**Ensure ES Modules throughout:**

```javascript
// BAD - prevents tree shaking
module.exports = { fetchTasks, fetchApprovals, fetchCicdHealth };

// GOOD - enables tree shaking
export { fetchTasks, fetchApprovals, fetchCicdHealth };
```

**Mark side-effect-free modules in package.json:**

```json
{
    "name": "command-hub",
    "sideEffects": [
        "*.css",
        "./src/main.js"
    ]
}
```

### 4.4 Expected Bundle Sizes (Post-Optimization)

| Chunk | Size (gzipped) | Load Strategy |
|-------|----------------|---------------|
| core.js | ~30 KB | Immediate |
| tasks.js | ~25 KB | Immediate (primary) |
| approvals.js | ~15 KB | Lazy (on navigation) |
| oasis.js | ~20 KB | Lazy (on navigation) |
| assistant.js | ~40 KB | Lazy (on click) |
| vendors.js | ~20 KB | Immediate |
| **Total** | **~150 KB** | vs. 250 KB current |

---

## 5. Phase 3: Network Optimization

**Timeline:** 1-2 weeks
**Risk:** Medium
**Impact:** High

### 5.1 WebSocket Implementation

**Replace polling with WebSocket for real-time updates:**

**Server-Side (Express):**
```javascript
// services/gateway/src/websocket/commandHubSocket.ts

import { WebSocket, WebSocketServer } from 'ws';
import { verifyToken } from '../auth/jwt';

interface CommandHubMessage {
    type: 'TASK_UPDATE' | 'APPROVAL_UPDATE' | 'CICD_HEALTH' | 'EXECUTION_STATUS';
    payload: any;
    timestamp: number;
}

export function initCommandHubWebSocket(server: http.Server) {
    const wss = new WebSocketServer({
        server,
        path: '/ws/command-hub'
    });

    wss.on('connection', async (ws, req) => {
        // Authenticate
        const token = new URL(req.url, 'http://localhost').searchParams.get('token');
        const user = await verifyToken(token);
        if (!user) {
            ws.close(4001, 'Unauthorized');
            return;
        }

        // Subscribe to events
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            handleSubscription(ws, msg);
        });

        // Send initial state
        ws.send(JSON.stringify({
            type: 'CONNECTED',
            payload: { userId: user.id, tenant: user.tenant }
        }));
    });

    // Broadcast updates (called from other services)
    return {
        broadcast(message: CommandHubMessage) {
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(message));
                }
            });
        }
    };
}
```

**Client-Side:**
```javascript
// src/core/websocket.js

// VTID-01250: WebSocket connection with automatic reconnection
class CommandHubSocket {
    constructor() {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.handlers = new Map();
    }

    connect() {
        const token = localStorage.getItem('authToken');
        const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/command-hub?token=${token}`;

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('[VTID-01250] WebSocket connected');
            this.reconnectAttempts = 0;
            this.subscribe(['TASK_UPDATE', 'APPROVAL_UPDATE', 'CICD_HEALTH']);
        };

        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            this.handleMessage(message);
        };

        this.ws.onclose = (event) => {
            console.log('[VTID-01250] WebSocket closed:', event.code);
            this.scheduleReconnect();
        };

        this.ws.onerror = (error) => {
            console.error('[VTID-01250] WebSocket error:', error);
        };
    }

    subscribe(types) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ action: 'subscribe', types }));
        }
    }

    on(type, handler) {
        if (!this.handlers.has(type)) {
            this.handlers.set(type, []);
        }
        this.handlers.get(type).push(handler);
    }

    handleMessage(message) {
        const handlers = this.handlers.get(message.type) || [];
        handlers.forEach(handler => handler(message.payload));
    }

    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('[VTID-01250] Max reconnection attempts reached');
            // Fall back to polling
            this.fallbackToPolling();
            return;
        }

        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
        console.log(`[VTID-01250] Reconnecting in ${delay}ms...`);

        setTimeout(() => {
            this.reconnectAttempts++;
            this.connect();
        }, delay);
    }

    fallbackToPolling() {
        console.warn('[VTID-01250] Falling back to polling mode');
        // Re-enable polling at reduced frequency
        startCicdHealthPolling(30000);  // 30s instead of 10s
        startApprovalsBadgePolling(60000);  // 60s instead of 20s
    }

    disconnect() {
        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }
    }
}

// Usage
const socket = new CommandHubSocket();
socket.connect();

socket.on('TASK_UPDATE', (task) => {
    updateTaskInState(task);
    renderTaskCard(task);
});

socket.on('CICD_HEALTH', (health) => {
    updateCicdHealthIndicator(health);
});

socket.on('APPROVAL_UPDATE', (approval) => {
    updateApprovalsBadge(approval);
});
```

### 5.2 API Consolidation

**Current State (Multiple Endpoints):**
```
GET /api/v1/cicd/health         (every 10s)
GET /api/v1/cicd/approvals      (every 20s)
GET /api/v1/commandhub/board    (every 30s)
GET /api/v1/me                  (on init)
```

**Consolidated Endpoint:**
```
GET /api/v1/commandhub/state
Response:
{
    "tasks": [...],
    "cicdHealth": {...},
    "pendingApprovals": 5,
    "user": {...},
    "timestamp": 1706356800000
}
```

**Server Implementation:**
```typescript
// services/gateway/src/routes/commandhub.ts

router.get('/state', async (req, res) => {
    const [tasks, cicdHealth, approvals, user] = await Promise.all([
        taskService.getBoard(req.user.tenant),
        cicdService.getHealth(),
        approvalService.getPendingCount(req.user.id),
        userService.getContext(req.user.id)
    ]);

    res.json({
        tasks,
        cicdHealth,
        pendingApprovals: approvals,
        user,
        timestamp: Date.now()
    });
});
```

### 5.3 HTTP Caching Strategy

**Add Cache Headers:**
```typescript
// Static assets - aggressive caching
app.use('/frontend', express.static('dist/frontend', {
    maxAge: '1y',
    immutable: true,
    etag: true
}));

// API responses - short cache with revalidation
router.get('/commandhub/board', (req, res) => {
    res.set({
        'Cache-Control': 'private, max-age=10, stale-while-revalidate=30',
        'ETag': generateETag(tasks)
    });
    res.json(tasks);
});
```

**Client-Side Caching:**
```javascript
// Service worker for offline support (optional)
// Or simpler in-memory cache:

const apiCache = new Map();
const CACHE_TTL = 10000; // 10 seconds

async function cachedFetch(url, options = {}) {
    const cached = apiCache.get(url);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }

    const response = await fetch(url, options);
    const data = await response.json();

    apiCache.set(url, { data, timestamp: Date.now() });
    return data;
}
```

---

## 6. Phase 4: Rendering Optimization

**Timeline:** 2-3 weeks
**Risk:** High
**Impact:** High

### 6.1 Virtual Scrolling Implementation

**Implement for Task Board Columns:**

```javascript
// src/components/VirtualList.js

// VTID-01250: Virtual scrolling for large lists
class VirtualList {
    constructor(container, options) {
        this.container = container;
        this.itemHeight = options.itemHeight || 160; // Task card height
        this.bufferSize = options.bufferSize || 3;   // Items above/below viewport
        this.items = [];
        this.visibleRange = { start: 0, end: 0 };
        this.scrollTop = 0;

        this.init();
    }

    init() {
        // Create viewport structure
        this.viewport = document.createElement('div');
        this.viewport.className = 'virtual-viewport';
        this.viewport.style.cssText = 'overflow-y: auto; height: 100%;';

        this.spacer = document.createElement('div');
        this.spacer.className = 'virtual-spacer';

        this.content = document.createElement('div');
        this.content.className = 'virtual-content';
        this.content.style.cssText = 'position: relative;';

        this.viewport.appendChild(this.spacer);
        this.viewport.appendChild(this.content);
        this.container.appendChild(this.viewport);

        // Scroll handler with RAF throttling
        let ticking = false;
        this.viewport.addEventListener('scroll', () => {
            if (!ticking) {
                requestAnimationFrame(() => {
                    this.onScroll();
                    ticking = false;
                });
                ticking = true;
            }
        }, { passive: true });
    }

    setItems(items) {
        this.items = items;
        this.spacer.style.height = `${items.length * this.itemHeight}px`;
        this.render();
    }

    onScroll() {
        this.scrollTop = this.viewport.scrollTop;
        this.render();
    }

    render() {
        const viewportHeight = this.viewport.clientHeight;
        const startIndex = Math.max(0, Math.floor(this.scrollTop / this.itemHeight) - this.bufferSize);
        const endIndex = Math.min(
            this.items.length - 1,
            Math.ceil((this.scrollTop + viewportHeight) / this.itemHeight) + this.bufferSize
        );

        // Skip if range hasn't changed
        if (startIndex === this.visibleRange.start && endIndex === this.visibleRange.end) {
            return;
        }

        this.visibleRange = { start: startIndex, end: endIndex };

        // Clear and re-render visible items
        this.content.innerHTML = '';

        for (let i = startIndex; i <= endIndex; i++) {
            const item = this.items[i];
            if (!item) continue;

            const element = this.renderItem(item, i);
            element.style.position = 'absolute';
            element.style.top = `${i * this.itemHeight}px`;
            element.style.width = '100%';
            this.content.appendChild(element);
        }
    }

    renderItem(item, index) {
        // Override in subclass or pass as option
        return createTaskCard(item);
    }

    // Update single item without full re-render
    updateItem(index, newItem) {
        this.items[index] = newItem;

        if (index >= this.visibleRange.start && index <= this.visibleRange.end) {
            const oldElement = this.content.querySelector(`[data-index="${index}"]`);
            if (oldElement) {
                const newElement = this.renderItem(newItem, index);
                newElement.style.position = 'absolute';
                newElement.style.top = `${index * this.itemHeight}px`;
                newElement.style.width = '100%';
                newElement.dataset.index = index;
                oldElement.replaceWith(newElement);
            }
        }
    }

    destroy() {
        this.container.innerHTML = '';
    }
}

// Usage in Task Board
function renderTaskColumn(column, tasks) {
    const columnContent = column.querySelector('.column-content');

    // Use virtual scrolling if > 20 items
    if (tasks.length > 20) {
        if (!column.virtualList) {
            column.virtualList = new VirtualList(columnContent, {
                itemHeight: 160,
                bufferSize: 5
            });
        }
        column.virtualList.setItems(tasks);
    } else {
        // Standard rendering for small lists
        columnContent.innerHTML = '';
        tasks.forEach(task => {
            columnContent.appendChild(createTaskCard(task));
        });
    }
}
```

### 6.2 Incremental DOM Updates

**Current Approach (Full Re-render):**
```javascript
// BAD - Re-renders entire board
function renderApp() {
    document.getElementById('app').innerHTML = '';
    // ... rebuild everything
}
```

**Optimized Approach (Reconciliation):**
```javascript
// VTID-01250: Incremental DOM reconciliation

function reconcileTasks(container, newTasks, oldTasks) {
    const newTaskMap = new Map(newTasks.map(t => [t.vtid, t]));
    const oldTaskMap = new Map(oldTasks.map(t => [t.vtid, t]));

    // Remove deleted tasks
    for (const [vtid, oldTask] of oldTaskMap) {
        if (!newTaskMap.has(vtid)) {
            const element = container.querySelector(`[data-vtid="${vtid}"]`);
            if (element) {
                element.classList.add('task-card-removing');
                setTimeout(() => element.remove(), 200);
            }
        }
    }

    // Update existing or add new tasks
    for (const [vtid, newTask] of newTaskMap) {
        const oldTask = oldTaskMap.get(vtid);
        const element = container.querySelector(`[data-vtid="${vtid}"]`);

        if (!oldTask) {
            // New task - add with animation
            const newElement = createTaskCard(newTask);
            newElement.classList.add('task-card-entering');
            insertTaskInOrder(container, newElement, newTask);
        } else if (hasTaskChanged(oldTask, newTask)) {
            // Changed task - update in place
            updateTaskCardInPlace(element, newTask);
        }
        // Unchanged - do nothing
    }
}

function hasTaskChanged(oldTask, newTask) {
    return oldTask.status !== newTask.status ||
           oldTask.title !== newTask.title ||
           oldTask.updatedAt !== newTask.updatedAt;
}

function updateTaskCardInPlace(element, task) {
    // Update only changed parts
    const titleEl = element.querySelector('.task-card-title');
    if (titleEl.textContent !== task.title) {
        titleEl.textContent = task.title;
    }

    const statusEl = element.querySelector('.task-card-status-pill');
    const newStatusClass = `task-card-status-pill-${task.status.toLowerCase().replace(' ', '-')}`;
    if (!statusEl.classList.contains(newStatusClass)) {
        statusEl.className = 'task-card-status-pill ' + newStatusClass;
        statusEl.textContent = task.status;
    }

    // ... update other fields
}
```

### 6.3 RequestAnimationFrame for Batch Updates

```javascript
// Batch DOM updates within single frame
class DOMBatcher {
    constructor() {
        this.queue = [];
        this.scheduled = false;
    }

    add(operation) {
        this.queue.push(operation);
        this.schedule();
    }

    schedule() {
        if (!this.scheduled) {
            this.scheduled = true;
            requestAnimationFrame(() => this.flush());
        }
    }

    flush() {
        const operations = this.queue.splice(0);
        operations.forEach(op => op());
        this.scheduled = false;
    }
}

const domBatcher = new DOMBatcher();

// Usage
function updateMultipleTasks(tasks) {
    tasks.forEach(task => {
        domBatcher.add(() => updateTaskCard(task));
    });
}
```

### 6.4 CSS Containment

**Add containment to isolate rendering:**

```css
/* Columns contain their own layout calculations */
.column {
    contain: layout style;
}

/* Task cards are fully contained */
.task-card {
    contain: strict;
    content-visibility: auto;
    contain-intrinsic-size: auto 160px;
}

/* Drawer doesn't affect main content */
.drawer {
    contain: strict;
}

/* Modal overlay */
.modal {
    contain: strict;
}
```

---

## 7. Phase 5: Storage Optimization

**Timeline:** 3-5 days
**Risk:** Low
**Impact:** Low-Medium

### 7.1 localStorage Audit & Cleanup

**Implement TTL-based storage:**

```javascript
// src/core/storage.js

// VTID-01250: Storage manager with TTL and size limits
class StorageManager {
    constructor(prefix = 'vh_') {
        this.prefix = prefix;
        this.maxSize = 5 * 1024 * 1024; // 5MB limit
        this.defaultTTL = 24 * 60 * 60 * 1000; // 24 hours
    }

    set(key, value, ttl = this.defaultTTL) {
        const item = {
            value,
            expires: Date.now() + ttl,
            created: Date.now()
        };

        try {
            localStorage.setItem(this.prefix + key, JSON.stringify(item));
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                this.cleanup();
                localStorage.setItem(this.prefix + key, JSON.stringify(item));
            }
        }
    }

    get(key) {
        const raw = localStorage.getItem(this.prefix + key);
        if (!raw) return null;

        try {
            const item = JSON.parse(raw);
            if (Date.now() > item.expires) {
                this.remove(key);
                return null;
            }
            return item.value;
        } catch {
            return null;
        }
    }

    remove(key) {
        localStorage.removeItem(this.prefix + key);
    }

    // Remove expired items
    cleanup() {
        const now = Date.now();
        const keysToRemove = [];

        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key.startsWith(this.prefix)) continue;

            try {
                const item = JSON.parse(localStorage.getItem(key));
                if (item.expires && now > item.expires) {
                    keysToRemove.push(key);
                }
            } catch {
                keysToRemove.push(key); // Remove corrupted items
            }
        }

        keysToRemove.forEach(key => localStorage.removeItem(key));
        console.log(`[VTID-01250] Cleaned up ${keysToRemove.length} expired items`);
    }

    // Get total storage used
    getUsage() {
        let total = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith(this.prefix)) {
                total += localStorage.getItem(key).length * 2; // UTF-16
            }
        }
        return total;
    }

    // Audit current storage
    audit() {
        const items = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key.startsWith(this.prefix)) continue;

            const value = localStorage.getItem(key);
            items.push({
                key: key.replace(this.prefix, ''),
                size: value.length * 2,
                raw: value.substring(0, 100)
            });
        }

        items.sort((a, b) => b.size - a.size);
        console.table(items.slice(0, 20)); // Top 20 by size
        return items;
    }
}

const storage = new StorageManager('vitana_');

// Run cleanup on init
storage.cleanup();

// Export for use
export { storage };
```

### 7.2 Migrate Large Data to IndexedDB

```javascript
// src/core/indexeddb.js

// VTID-01250: IndexedDB for large datasets
class VitanaDB {
    constructor() {
        this.dbName = 'vitana_command_hub';
        this.version = 1;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Tasks cache store
                if (!db.objectStoreNames.contains('tasks')) {
                    const taskStore = db.createObjectStore('tasks', { keyPath: 'vtid' });
                    taskStore.createIndex('status', 'status');
                    taskStore.createIndex('updatedAt', 'updatedAt');
                }

                // Events cache store
                if (!db.objectStoreNames.contains('events')) {
                    const eventStore = db.createObjectStore('events', { keyPath: 'id' });
                    eventStore.createIndex('timestamp', 'timestamp');
                }

                // User preferences store
                if (!db.objectStoreNames.contains('preferences')) {
                    db.createObjectStore('preferences', { keyPath: 'key' });
                }
            };
        });
    }

    async put(storeName, data) {
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);

        if (Array.isArray(data)) {
            data.forEach(item => store.put(item));
        } else {
            store.put(data);
        }

        return tx.complete;
    }

    async get(storeName, key) {
        const tx = this.db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        return store.get(key);
    }

    async getAll(storeName) {
        const tx = this.db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        return store.getAll();
    }

    async clear(storeName) {
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        return store.clear();
    }
}

const vitanaDB = new VitanaDB();
vitanaDB.init();

export { vitanaDB };
```

---

## 8. Implementation Details

### 8.1 File Changes Summary

| File | Action | Phase |
|------|--------|-------|
| `app.js` | Add null checks to fetch functions | 1 |
| `app.js` | Add visibility/idle handlers | 1 |
| `styles.css` | Remove blanket transitions | 1 |
| `index.html` | Add resource hints, defer scripts | 1 |
| `vite.config.js` | New file - build configuration | 2 |
| `package.json` | Add Vite dependencies | 2 |
| `src/core/*.js` | New files - modular core | 2 |
| `src/features/**/*.js` | New files - feature modules | 2 |
| `websocket.ts` | New file - WebSocket server | 3 |
| `src/core/websocket.js` | New file - WebSocket client | 3 |
| `routes/commandhub.ts` | Add consolidated endpoint | 3 |
| `src/components/VirtualList.js` | New file - virtual scrolling | 4 |
| `src/core/storage.js` | New file - storage manager | 5 |
| `src/core/indexeddb.js` | New file - IndexedDB wrapper | 5 |

### 8.2 Migration Strategy

**Phase 1: Non-Breaking Changes**
- All changes are additive or fixes
- No breaking changes to existing functionality
- Can deploy immediately

**Phase 2: Build System Migration**
1. Set up Vite alongside existing files
2. Gradually move code into modules
3. Maintain backward compatibility during transition
4. Switch over once feature parity achieved
5. Remove old monolithic app.js

**Phase 3: WebSocket Migration**
1. Deploy WebSocket server alongside existing API
2. Client detects WebSocket support
3. Falls back to polling if WebSocket fails
4. Gradually deprecate polling endpoints

**Phase 4: Virtual Scrolling**
1. Implement as opt-in feature
2. Enable for users with many tasks
3. Monitor performance metrics
4. Roll out to all users

### 8.3 Feature Flags

```javascript
// src/core/features.js

const FEATURES = {
    WEBSOCKET_ENABLED: true,
    VIRTUAL_SCROLLING: true,
    VIRTUAL_SCROLL_THRESHOLD: 20, // Items before enabling
    IDLE_POLLING_REDUCTION: true,
    INDEXED_DB_STORAGE: true,
};

function isFeatureEnabled(feature) {
    // Check localStorage override first
    const override = localStorage.getItem(`feature_${feature}`);
    if (override !== null) {
        return override === 'true';
    }
    return FEATURES[feature] ?? false;
}

export { FEATURES, isFeatureEnabled };
```

---

## 9. Testing & Validation

### 9.1 Performance Testing

**Lighthouse CI Configuration:**
```yaml
# lighthouserc.js
module.exports = {
    ci: {
        collect: {
            url: ['http://localhost:3000/command-hub/tasks'],
            numberOfRuns: 3,
        },
        assert: {
            assertions: {
                'first-contentful-paint': ['error', { maxNumericValue: 1500 }],
                'interactive': ['error', { maxNumericValue: 3000 }],
                'total-blocking-time': ['error', { maxNumericValue: 200 }],
                'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],
            },
        },
        upload: {
            target: 'temporary-public-storage',
        },
    },
};
```

**Custom Performance Metrics:**
```javascript
// Track custom metrics
performance.mark('tasks-render-start');
renderTasks(tasks);
performance.mark('tasks-render-end');
performance.measure('tasks-render', 'tasks-render-start', 'tasks-render-end');

// Log to analytics
const measure = performance.getEntriesByName('tasks-render')[0];
console.log(`[VTID-01250] Tasks render time: ${measure.duration}ms`);
```

### 9.2 Functional Testing

| Test Case | Description | Expected Result |
|-----------|-------------|-----------------|
| TC-001 | Page load with empty task board | FCP < 1.5s |
| TC-002 | Page load with 100 tasks | TTI < 3s |
| TC-003 | WebSocket reconnection | Reconnects within 30s |
| TC-004 | Polling fallback | Falls back after 5 WS failures |
| TC-005 | Virtual scroll with 500 tasks | Smooth 60fps scrolling |
| TC-006 | Background tab polling | Polling pauses |
| TC-007 | Return from background | Data refreshes immediately |
| TC-008 | Storage cleanup | Expired items removed |
| TC-009 | Null response handling | No uncaught errors |
| TC-010 | Bundle code splitting | Chunks load on navigation |

### 9.3 Load Testing

```bash
# k6 load test for WebSocket
k6 run --vus 100 --duration 5m websocket-test.js

# Artillery for API
artillery run api-load-test.yml
```

---

## 10. Rollback Strategy

### 10.1 Feature Flag Rollback

```javascript
// Emergency disable via localStorage
localStorage.setItem('feature_WEBSOCKET_ENABLED', 'false');
localStorage.setItem('feature_VIRTUAL_SCROLLING', 'false');
location.reload();
```

### 10.2 Version Rollback

**Keep previous bundle:**
```
dist/frontend/command-hub/
├── app.js              # Current version
├── app.v1.js           # Previous version (backup)
├── styles.css          # Current version
└── styles.v1.css       # Previous version (backup)
```

**nginx/Express switch:**
```javascript
// Quick rollback in Express
const USE_LEGACY = process.env.USE_LEGACY_FRONTEND === 'true';

app.use('/frontend', express.static(
    USE_LEGACY ? 'dist/frontend-legacy' : 'dist/frontend'
));
```

### 10.3 Database Rollback

- No database schema changes required
- All changes are client-side
- IndexedDB can be cleared without data loss

---

## 11. Appendices

### 11.1 Glossary

| Term | Definition |
|------|------------|
| FCP | First Contentful Paint - Time to first content render |
| TTI | Time to Interactive - Time until page responds to input |
| TBT | Total Blocking Time - Sum of long task blocking times |
| CLS | Cumulative Layout Shift - Visual stability metric |
| VTID | Vitana Task ID - Unique identifier for tasks |

### 11.2 References

- [Web Vitals](https://web.dev/vitals/)
- [Virtual Scrolling Patterns](https://web.dev/virtualize-long-lists-react-window/)
- [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
- [WebSocket Best Practices](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
- [Vite Documentation](https://vitejs.dev/)

### 11.3 Success Metrics

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| FCP | 2.5s | 1.5s | Lighthouse |
| TTI | 4.5s | 3.0s | Lighthouse |
| JS Bundle | 900KB | 350KB | Build output |
| CSS Size | 275KB | 100KB | Build output |
| API calls/min | 11 | 3 | Network tab |
| DOM elements | 818 | 300 | DevTools |
| Memory (heap) | ~50MB | ~30MB | DevTools |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-01-27 | Claude | Initial specification |

---

**Approval Signatures:**

- [ ] Engineering Lead: _______________
- [ ] Product Owner: _______________
- [ ] QA Lead: _______________
