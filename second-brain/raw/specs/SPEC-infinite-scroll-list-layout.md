# Specification: Infinite Scroll List Layout Standardization

**VTID:** VTID-01188
**Status:** Draft
**Author:** Claude
**Date:** 2026-01-18

---

## 1. Overview

This specification defines changes for two list screens in Command Hub:
1. **OASIS Events** - Fix layout, add infinite scroll
2. **VTID Ledger** - Fix layout, make rows clickable, add infinite scroll

### 1.1 Universal 3-Row Structure

All list screens MUST have exactly **3 rows** before the table:

| Row | Content | Rule |
|-----|---------|------|
| **Row 1** | Global top bar (AUTOPILOT \| OPERATOR \| PUBLISH ... LIVE \| refresh) | **DO NOT CHANGE** |
| **Row 2** | Section tab navigation | **DO NOT CHANGE** |
| **Row 3** | Toolbar (filters + item count only) | **Filters left, count right** |

Then immediately: **Table with sticky headers + scrollable list + Load More**

---

## 2. OASIS Events Screen

### 2.1 Current State (BAD)

```
┌────────────────────────────────────────────────────────────┐
│ AUTOPILOT | OPERATOR | PUBLISH          ● LIVE    ↻       │ ← Row 1 (OK)
├────────────────────────────────────────────────────────────┤
│ Events | VTID Ledger | Entities | Streams | Command Log   │ ← Row 2 (OK)
├────────────────────────────────────────────────────────────┤
│ Auto-refresh (5s): [ON]                                    │ ← REMOVE
├────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────┐   │
│ │ All Topics                                        ▼ │   │ ← MOVE
│ └─────────────────────────────────────────────────────┘   │
├────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────┐   │
│ │ All Status                                        ▼ │   │ ← MOVE
│ └─────────────────────────────────────────────────────┘   │
├────────────────────────────────────────────────────────────┤
│ ● LIVE - Auto-refreshing                                   │ ← REMOVE
├────────────────────────────────────────────────────────────┤
│ Severity | Timestamp | Topic | VTID | Service | Status    │
├────────────────────────────────────────────────────────────┤
│                     List items...                          │
│                     (no Load More, no scroll)              │
└────────────────────────────────────────────────────────────┘
```

### 2.2 Target State (GOOD)

```
┌────────────────────────────────────────────────────────────┐
│ AUTOPILOT | OPERATOR | PUBLISH          ● LIVE    ↻       │ ← Row 1
├────────────────────────────────────────────────────────────┤
│ Events | VTID Ledger | Entities | Streams | Command Log   │ ← Row 2
├────────────────────────────────────────────────────────────┤
│ [All Topics▼] [All Status▼]                     50 events │ ← Row 3
├────────────────────────────────────────────────────────────┤
│ Severity | Timestamp | Topic | VTID | Service | Status    │ ← Sticky header
├────────────────────────────────────────────────────────────┤
│  ●  Jan 18, 05:26 PM  governance.control.updated  ...     │
│  ●  Jan 18, 05:23 PM  vtid.tts.failure            ...     │
│  ●  Jan 18, 05:23 PM  memory.write.assistant      ...     │
│                        (scrollable)                        │
├────────────────────────────────────────────────────────────┤
│                    [ Load More ]                           │
└────────────────────────────────────────────────────────────┘
```

### 2.3 Changes Required

| Change | Description |
|--------|-------------|
| **REMOVE** | Auto-refresh toggle row (Row 1 has refresh icon) |
| **REMOVE** | "LIVE - Auto-refreshing" indicator row (Row 1 has LIVE badge) |
| **MOVE** | Topic filter dropdown → Row 3 toolbar (left) |
| **MOVE** | Status filter dropdown → Row 3 toolbar (left, after Topic) |
| **ADD** | Item count "50 events" → Row 3 toolbar (right) |
| **ADD** | Infinite scroll with "Load More" button |
| **ADD** | Pagination state management |

### 2.4 Row 3 Toolbar HTML

```html
<div class="list-toolbar">
  <div class="list-toolbar__filters">
    <select class="filter-dropdown" id="oasis-topic-filter">
      <option value="">All Topics</option>
      <option value="deploy">deploy</option>
      <option value="governance">governance</option>
      <option value="ci-cd">CI/CD</option>
      <option value="autopilot">autopilot</option>
      <option value="operator">operator</option>
    </select>
    <select class="filter-dropdown" id="oasis-status-filter">
      <option value="">All Status</option>
      <option value="SUCCESS">Success</option>
      <option value="ERROR">Error</option>
      <option value="INFO">Info</option>
    </select>
  </div>
  <div class="list-toolbar__metadata">
    <span id="oasis-events-count">50 events</span>
  </div>
</div>
```

### 2.5 Function Changes

**File:** `services/gateway/src/frontend/command-hub/app.js`

#### 2.5.1 Modify `renderOasisEventsView()` (~line 10726)

```javascript
function renderOasisEventsView() {
  return `
    <div class="oasis-events-view" data-view="oasis-events">
      <!-- Row 3: Toolbar -->
      <div class="list-toolbar">
        <div class="list-toolbar__filters">
          <select class="filter-dropdown" id="oasis-topic-filter" onchange="handleOasisFilterChange()">
            <option value="">All Topics</option>
            <option value="deploy">deploy</option>
            <option value="governance">governance</option>
            <option value="ci-cd">CI/CD</option>
            <option value="autopilot">autopilot</option>
            <option value="operator">operator</option>
          </select>
          <select class="filter-dropdown" id="oasis-status-filter" onchange="handleOasisFilterChange()">
            <option value="">All Status</option>
            <option value="SUCCESS">Success</option>
            <option value="ERROR">Error</option>
            <option value="INFO">Info</option>
          </select>
        </div>
        <div class="list-toolbar__metadata">
          <span id="oasis-events-count">${state.oasisEvents.items.length} events</span>
        </div>
      </div>

      <!-- Table -->
      <div class="list-scroll-container">
        <table class="list-table oasis-events-table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Timestamp</th>
              <th>Topic</th>
              <th>VTID</th>
              <th>Service</th>
              <th>Status</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody id="oasis-events-tbody">
            <!-- Rows inserted dynamically -->
          </tbody>
        </table>

        <!-- Load More -->
        <div class="load-more-container" id="oasis-load-more">
          <button class="load-more-btn" onclick="loadMoreOasisEvents()">Load More</button>
        </div>
      </div>
    </div>
  `;
}
```

#### 2.5.2 Add Pagination State

```javascript
// Update initial state
state.oasisEvents = {
  items: [],
  loading: false,
  error: null,
  fetched: false,
  selectedEvent: null,
  filters: { topic: '', status: '' },
  pagination: {
    limit: 50,
    offset: 0,
    hasMore: true
  }
};
```

#### 2.5.3 Modify `fetchOasisEvents()` (~line 2772)

```javascript
async function fetchOasisEvents(append = false) {
  if (state.oasisEvents.loading) return;
  if (append && !state.oasisEvents.pagination.hasMore) return;

  state.oasisEvents.loading = true;
  updateLoadMoreButton('oasis-load-more', true);

  try {
    const { pagination, filters } = state.oasisEvents;
    const offset = append ? pagination.offset : 0;

    const params = new URLSearchParams({
      limit: pagination.limit,
      offset: offset
    });
    if (filters.topic) params.append('topic', filters.topic);
    if (filters.status) params.append('status', filters.status);

    const response = await fetch(`/api/v1/oasis/events?${params}`);
    const result = await response.json();

    if (append) {
      state.oasisEvents.items = [...state.oasisEvents.items, ...result.data];
    } else {
      state.oasisEvents.items = result.data;
    }

    state.oasisEvents.pagination = {
      ...pagination,
      offset: offset + result.data.length,
      hasMore: result.pagination?.has_more ?? result.data.length === pagination.limit
    };

    state.oasisEvents.fetched = true;
    state.oasisEvents.error = null;

  } catch (error) {
    state.oasisEvents.error = error.message;
  } finally {
    state.oasisEvents.loading = false;
    updateOasisEventsTableBody();
    updateEventCount('oasis-events-count', state.oasisEvents.items.length, 'events');
    updateLoadMoreButton('oasis-load-more', false, state.oasisEvents.pagination.hasMore);
  }
}

function loadMoreOasisEvents() {
  fetchOasisEvents(true);
}

function handleOasisFilterChange() {
  state.oasisEvents.filters = {
    topic: document.getElementById('oasis-topic-filter')?.value || '',
    status: document.getElementById('oasis-status-filter')?.value || ''
  };
  state.oasisEvents.pagination.offset = 0;
  state.oasisEvents.pagination.hasMore = true;
  fetchOasisEvents(false);
}
```

---

## 3. VTID Ledger Screen

### 3.1 Current State (BAD)

```
┌────────────────────────────────────────────────────────────┐
│ AUTOPILOT | OPERATOR | PUBLISH          ● LIVE    ↻       │ ← Row 1 (OK)
├────────────────────────────────────────────────────────────┤
│ Events | VTID Ledger | Entities | Streams | Command Log   │ ← Row 2 (OK)
├────────────────────────────────────────────────────────────┤
│ VTID Ledger                                                │ ← REMOVE (redundant)
├────────────────────────────────────────────────────────────┤
│ View: OASIS_VTID_LEDGER_ACTIVE (VTID-01001)               │ ← REMOVE (unnecessary)
├────────────────────────────────────────────────────────────┤
│ Authoritative VTID registry. Click a row to view...       │ ← REMOVE (text is useless)
├────────────────────────────────────────────────────────────┤
│ Loaded 50 VTIDs from Ledger                                │ ← MOVE count to Row 3
├────────────────────────────────────────────────────────────┤
│ VTID | Title | Stage | Status | Attention | Last Update   │ ← Table header
├────────────────────────────────────────────────────────────┤
│ VTID-01187  01187 - ORB Voice...   Done  Success  AUTO    │ ← NOT CLICKABLE!
│ VTID-01186  VTID-01186 - Replace   Done  Success  AUTO    │
│                     (no Load More)                         │
└────────────────────────────────────────────────────────────┘
```

**Critical Bug:** Text says "Click a row to view lifecycle, events, governance, and provenance" but rows are NOT clickable.

### 3.2 Target State (GOOD)

```
┌────────────────────────────────────────────────────────────┐
│ AUTOPILOT | OPERATOR | PUBLISH          ● LIVE    ↻       │ ← Row 1
├────────────────────────────────────────────────────────────┤
│ Events | VTID Ledger | Entities | Streams | Command Log   │ ← Row 2
├────────────────────────────────────────────────────────────┤
│                                                  50 VTIDs │ ← Row 3 (count only)
├────────────────────────────────────────────────────────────┤
│ VTID | Title | Stage | Status | Attention | Last Update   │ ← Sticky header
├────────────────────────────────────────────────────────────┤
│ VTID-01187  01187 - ORB Voice...   Done  Success  AUTO    │ ← CLICKABLE
│ VTID-01186  VTID-01186 - Replace   Done  Success  AUTO    │ ← CLICKABLE
│ VTID-01185  VTID-01185 - Autopilot Done  Success  AUTO    │ ← CLICKABLE
│                        (scrollable)                        │
├────────────────────────────────────────────────────────────┤
│                    [ Load More ]                           │
└────────────────────────────────────────────────────────────┘
```

### 3.3 Changes Required

| Change | Description |
|--------|-------------|
| **REMOVE** | "VTID Ledger" title (tab already shows this) |
| **REMOVE** | "View: OASIS_VTID_LEDGER_ACTIVE (VTID-01001)" label |
| **REMOVE** | Description text "Authoritative VTID registry..." |
| **MOVE** | Count "50 VTIDs" → Row 3 toolbar (right side) |
| **FIX** | Make table rows CLICKABLE |
| **ADD** | Row click handler to show VTID detail drawer |
| **ADD** | Infinite scroll with "Load More" button |
| **ADD** | Pagination state management |

### 3.4 Row Click Behavior

When a VTID row is clicked, display a detail drawer/panel showing:
- VTID identifier
- Title
- Stage timeline
- Status history
- Governance events
- Provenance data

### 3.5 Row 3 Toolbar HTML

```html
<div class="list-toolbar">
  <div class="list-toolbar__filters">
    <!-- No filters needed for VTID Ledger, or add Stage/Status filters if desired -->
  </div>
  <div class="list-toolbar__metadata">
    <span id="vtid-ledger-count">50 VTIDs</span>
  </div>
</div>
```

### 3.6 Function Changes

**File:** `services/gateway/src/frontend/command-hub/app.js`

#### 3.6.1 Modify `renderOasisVtidLedgerView()` (~line 11883)

```javascript
function renderOasisVtidLedgerView() {
  return `
    <div class="vtid-ledger-view" data-view="vtid-ledger">
      <!-- Row 3: Toolbar (count only) -->
      <div class="list-toolbar">
        <div class="list-toolbar__filters"></div>
        <div class="list-toolbar__metadata">
          <span id="vtid-ledger-count">${state.vtidLedger.items.length} VTIDs</span>
        </div>
      </div>

      <!-- Table -->
      <div class="list-scroll-container">
        <table class="list-table vtid-ledger-table">
          <thead>
            <tr>
              <th>VTID</th>
              <th>Title</th>
              <th>Stage</th>
              <th>Status</th>
              <th>Attention</th>
              <th>Last Update</th>
            </tr>
          </thead>
          <tbody id="vtid-ledger-tbody">
            <!-- Rows inserted dynamically -->
          </tbody>
        </table>

        <!-- Load More -->
        <div class="load-more-container" id="vtid-load-more">
          <button class="load-more-btn" onclick="loadMoreVtidLedger()">Load More</button>
        </div>
      </div>

      <!-- Detail Drawer (hidden by default) -->
      <div class="vtid-detail-drawer" id="vtid-detail-drawer" style="display: none;">
        <!-- Populated when row clicked -->
      </div>
    </div>
  `;
}
```

#### 3.6.2 Add Pagination State

```javascript
// Update initial state
state.vtidLedger = {
  items: [],
  loading: false,
  error: null,
  fetched: false,
  selectedVtid: null,
  pagination: {
    limit: 50,
    offset: 0,
    hasMore: true
  }
};
```

#### 3.6.3 Create Clickable Rows

```javascript
function createVtidLedgerRow(vtid) {
  const tr = document.createElement('tr');
  tr.className = 'vtid-ledger-row clickable-row';
  tr.dataset.vtid = vtid.vtid_id;
  tr.onclick = () => handleVtidRowClick(vtid);

  tr.innerHTML = `
    <td class="vtid-id">${vtid.vtid_id}</td>
    <td class="vtid-title">${escapeHtml(vtid.title)}</td>
    <td><span class="stage-badge stage-${vtid.stage?.toLowerCase()}">${vtid.stage || '-'}</span></td>
    <td><span class="status-badge status-${vtid.status?.toLowerCase()}">${vtid.status || '-'}</span></td>
    <td>${vtid.attention || 'AUTO'}</td>
    <td>${formatEventTimestamp(vtid.last_update)}</td>
  `;

  return tr;
}

function handleVtidRowClick(vtid) {
  state.vtidLedger.selectedVtid = vtid;
  showVtidDetailDrawer(vtid);
}

function showVtidDetailDrawer(vtid) {
  const drawer = document.getElementById('vtid-detail-drawer');
  if (!drawer) return;

  drawer.innerHTML = `
    <div class="drawer-header">
      <h3>${vtid.vtid_id}</h3>
      <button class="drawer-close" onclick="closeVtidDetailDrawer()">×</button>
    </div>
    <div class="drawer-content">
      <div class="detail-section">
        <h4>Title</h4>
        <p>${escapeHtml(vtid.title)}</p>
      </div>
      <div class="detail-section">
        <h4>Stage</h4>
        <span class="stage-badge stage-${vtid.stage?.toLowerCase()}">${vtid.stage || '-'}</span>
      </div>
      <div class="detail-section">
        <h4>Status</h4>
        <span class="status-badge status-${vtid.status?.toLowerCase()}">${vtid.status || '-'}</span>
      </div>
      <div class="detail-section">
        <h4>Last Update</h4>
        <p>${formatEventTimestamp(vtid.last_update)}</p>
      </div>
      <div class="detail-section">
        <h4>Lifecycle Events</h4>
        <div id="vtid-lifecycle-events">Loading...</div>
      </div>
      <div class="detail-section">
        <h4>Governance</h4>
        <div id="vtid-governance">Loading...</div>
      </div>
    </div>
  `;

  drawer.style.display = 'block';

  // Fetch additional details
  fetchVtidDetails(vtid.vtid_id);
}

function closeVtidDetailDrawer() {
  const drawer = document.getElementById('vtid-detail-drawer');
  if (drawer) {
    drawer.style.display = 'none';
    state.vtidLedger.selectedVtid = null;
  }
}

async function fetchVtidDetails(vtidId) {
  try {
    // Fetch lifecycle events
    const eventsResponse = await fetch(`/api/v1/oasis/events?vtid=${vtidId}&limit=20`);
    const eventsData = await eventsResponse.json();

    const eventsContainer = document.getElementById('vtid-lifecycle-events');
    if (eventsContainer && eventsData.data) {
      eventsContainer.innerHTML = eventsData.data.length > 0
        ? eventsData.data.map(e => `
            <div class="event-item">
              <span class="event-timestamp">${formatEventTimestamp(e.timestamp)}</span>
              <span class="event-topic">${e.topic}</span>
              <span class="event-status status-${e.status?.toLowerCase()}">${e.status}</span>
            </div>
          `).join('')
        : '<p class="no-data">No events found</p>';
    }

    // Fetch governance data
    const govResponse = await fetch(`/api/v1/governance/history?vtid=${vtidId}&limit=10`);
    const govData = await govResponse.json();

    const govContainer = document.getElementById('vtid-governance');
    if (govContainer && govData.data) {
      govContainer.innerHTML = govData.data.length > 0
        ? govData.data.map(g => `
            <div class="gov-item">
              <span class="gov-timestamp">${formatEventTimestamp(g.timestamp)}</span>
              <span class="gov-type">${g.type}</span>
              <span class="gov-actor">${g.actor}</span>
            </div>
          `).join('')
        : '<p class="no-data">No governance events</p>';
    }

  } catch (error) {
    console.error('Failed to fetch VTID details:', error);
  }
}
```

#### 3.6.4 Fetch with Pagination

```javascript
async function fetchVtidLedger(append = false) {
  if (state.vtidLedger.loading) return;
  if (append && !state.vtidLedger.pagination.hasMore) return;

  state.vtidLedger.loading = true;
  updateLoadMoreButton('vtid-load-more', true);

  try {
    const { pagination } = state.vtidLedger;
    const offset = append ? pagination.offset : 0;

    const params = new URLSearchParams({
      limit: pagination.limit,
      offset: offset
    });

    const response = await fetch(`/api/v1/oasis/vtid-ledger?${params}`);
    const result = await response.json();

    if (append) {
      state.vtidLedger.items = [...state.vtidLedger.items, ...result.data];
    } else {
      state.vtidLedger.items = result.data;
    }

    state.vtidLedger.pagination = {
      ...pagination,
      offset: offset + result.data.length,
      hasMore: result.pagination?.has_more ?? result.data.length === pagination.limit
    };

    state.vtidLedger.fetched = true;
    state.vtidLedger.error = null;

  } catch (error) {
    state.vtidLedger.error = error.message;
  } finally {
    state.vtidLedger.loading = false;
    updateVtidLedgerTableBody();
    updateEventCount('vtid-ledger-count', state.vtidLedger.items.length, 'VTIDs');
    updateLoadMoreButton('vtid-load-more', false, state.vtidLedger.pagination.hasMore);
  }
}

function loadMoreVtidLedger() {
  fetchVtidLedger(true);
}
```

---

## 4. Shared Components

### 4.1 CSS Styles

Add to `app.js` or separate CSS file:

```css
/* Row 3 Toolbar */
.list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color, #333);
  background: var(--bg-secondary, #1a1a2e);
  min-height: 48px;
}

.list-toolbar__filters {
  display: flex;
  gap: 8px;
  align-items: center;
}

.list-toolbar__metadata {
  color: var(--text-secondary, #888);
  font-size: 13px;
}

/* Filter Dropdowns */
.filter-dropdown {
  padding: 6px 12px;
  background: var(--bg-tertiary, #252540);
  border: 1px solid var(--border-color, #333);
  border-radius: 4px;
  color: var(--text-primary, #fff);
  font-size: 13px;
  cursor: pointer;
}

.filter-dropdown:hover {
  border-color: var(--border-hover, #555);
}

/* Scrollable List Container */
.list-scroll-container {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

/* Table */
.list-table {
  width: 100%;
  border-collapse: collapse;
}

.list-table thead {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--bg-secondary, #1a1a2e);
}

.list-table th {
  padding: 12px 16px;
  text-align: left;
  font-weight: 500;
  color: var(--text-secondary, #888);
  border-bottom: 1px solid var(--border-color, #333);
}

.list-table td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color, #333);
}

/* Clickable Rows */
.clickable-row {
  cursor: pointer;
  transition: background 0.15s ease;
}

.clickable-row:hover {
  background: var(--bg-hover, #252540);
}

.clickable-row.selected {
  background: var(--bg-selected, #2a2a4a);
}

/* Load More */
.load-more-container {
  display: flex;
  justify-content: center;
  padding: 24px 16px;
  border-top: 1px solid var(--border-color, #333);
}

.load-more-btn {
  padding: 10px 24px;
  background: var(--bg-tertiary, #252540);
  border: 1px solid var(--border-color, #333);
  border-radius: 6px;
  color: var(--text-primary, #fff);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.load-more-btn:hover:not(:disabled) {
  background: var(--bg-hover, #2a2a4a);
  border-color: var(--border-hover, #555);
}

.load-more-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.load-more-btn.loading {
  pointer-events: none;
}

.load-more-btn.loading::after {
  content: '';
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-left: 8px;
  border: 2px solid var(--border-color, #333);
  border-top-color: var(--accent-color, #4a9eff);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Detail Drawer */
.vtid-detail-drawer {
  position: fixed;
  right: 0;
  top: 0;
  width: 400px;
  height: 100vh;
  background: var(--bg-primary, #0f0f1a);
  border-left: 1px solid var(--border-color, #333);
  z-index: 100;
  overflow-y: auto;
  box-shadow: -4px 0 20px rgba(0,0,0,0.3);
}

.drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid var(--border-color, #333);
}

.drawer-header h3 {
  margin: 0;
  font-size: 18px;
}

.drawer-close {
  background: none;
  border: none;
  color: var(--text-secondary, #888);
  font-size: 24px;
  cursor: pointer;
}

.drawer-close:hover {
  color: var(--text-primary, #fff);
}

.drawer-content {
  padding: 16px;
}

.detail-section {
  margin-bottom: 20px;
}

.detail-section h4 {
  margin: 0 0 8px 0;
  font-size: 12px;
  text-transform: uppercase;
  color: var(--text-secondary, #888);
}

.no-data {
  color: var(--text-secondary, #888);
  font-style: italic;
}
```

### 4.2 Shared Helper Functions

```javascript
function updateLoadMoreButton(containerId, loading, hasMore = true) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const btn = container.querySelector('.load-more-btn');
  if (!btn) return;

  if (loading) {
    btn.disabled = true;
    btn.classList.add('loading');
    btn.textContent = 'Loading';
  } else {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = 'Load More';
  }

  // Hide container if no more data
  container.style.display = hasMore ? 'flex' : 'none';
}

function updateEventCount(elementId, count, label) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = `${count} ${label}`;
  }
}
```

---

## 5. API Changes

### 5.1 OASIS Events API

**Endpoint:** `GET /api/v1/oasis/events`

**Add parameters:**
- `offset` (integer, default: 0) - Starting position
- `limit` (integer, default: 50) - Items per page

**Response format:**
```json
{
  "data": [...],
  "pagination": {
    "limit": 50,
    "offset": 50,
    "has_more": true,
    "total": 1234
  }
}
```

### 5.2 VTID Ledger API

**Endpoint:** `GET /api/v1/oasis/vtid-ledger`

**Add parameters:**
- `offset` (integer, default: 0) - Starting position
- `limit` (integer, default: 50) - Items per page

**Remove:** Max limit of 200 (allow unlimited pagination)

**Response format:**
```json
{
  "data": [...],
  "pagination": {
    "limit": 50,
    "offset": 50,
    "has_more": true,
    "total": 500
  }
}
```

---

## 6. Implementation Checklist

### 6.1 OASIS Events Screen
- [ ] Remove auto-refresh toggle row
- [ ] Remove LIVE indicator row
- [ ] Create Row 3 toolbar with inline filters
- [ ] Add item count to toolbar
- [ ] Add pagination state to `state.oasisEvents`
- [ ] Modify `fetchOasisEvents()` for pagination
- [ ] Add `loadMoreOasisEvents()` function
- [ ] Add `handleOasisFilterChange()` function
- [ ] Add "Load More" button
- [ ] Update API to support offset pagination
- [ ] Test infinite scroll
- [ ] Test filter changes reset pagination

### 6.2 VTID Ledger Screen
- [ ] Remove "VTID Ledger" title
- [ ] Remove "View: OASIS_VTID_LEDGER_ACTIVE" label
- [ ] Remove description text
- [ ] Create Row 3 toolbar with count
- [ ] Add pagination state to `state.vtidLedger`
- [ ] Make table rows clickable
- [ ] Add `handleVtidRowClick()` function
- [ ] Add VTID detail drawer component
- [ ] Add `showVtidDetailDrawer()` function
- [ ] Add `fetchVtidDetails()` function
- [ ] Modify `fetchVtidLedger()` for pagination
- [ ] Add `loadMoreVtidLedger()` function
- [ ] Add "Load More" button
- [ ] Update API to support offset pagination
- [ ] Test infinite scroll
- [ ] Test row click opens drawer

### 6.3 Shared Components
- [ ] Add `.list-toolbar` CSS
- [ ] Add `.filter-dropdown` CSS
- [ ] Add `.list-scroll-container` CSS
- [ ] Add `.clickable-row` CSS
- [ ] Add `.load-more-container` CSS
- [ ] Add `.vtid-detail-drawer` CSS
- [ ] Add `updateLoadMoreButton()` helper
- [ ] Add `updateEventCount()` helper

---

## 7. Files to Modify

| File | Changes |
|------|---------|
| `services/gateway/src/frontend/command-hub/app.js` | Main frontend changes |
| `services/gateway/src/routes/events.ts` | Add offset param to events API |
| `services/gateway/src/routes/oasis-vtid-ledger.ts` | Add offset param, remove max limit |

---

## 8. Success Criteria

1. **OASIS Events:** 3 rows only, filters inline, infinite scroll works
2. **VTID Ledger:** 3 rows only, no text clutter, rows are clickable, infinite scroll works
3. **Consistency:** Both screens follow the same 3-row pattern
4. **Performance:** No degradation with 1000+ items loaded
5. **UX:** Smooth scrolling, clear loading feedback
