# Specification: Infinite Scroll List Layout Standardization

**VTID:** VTID-01188
**Status:** Draft
**Author:** Claude
**Date:** 2026-01-18

---

## 1. Overview

This specification defines a standardized layout for all list-based views in the Command Hub, implementing:
1. A consistent **3-row header structure** before list content
2. **Infinite scroll** with "Load More" functionality for endless data loading

### 1.1 Problem Statement

**Issue 1: Inconsistent Header Layout**

The Governance History page correctly uses a compact 3-row header:
- Row 1: Tab navigation
- Row 2: Filters + metadata (count)
- Row 3: Table column headers

However, the OASIS Events page uses 6+ rows:
- Row 1: Tab navigation
- Row 2: Auto-refresh toggle (separate row)
- Row 3: Topic filter dropdown (separate row)
- Row 4: Status filter dropdown (separate row)
- Row 5: "LIVE - Auto-refreshing" indicator (separate row)
- Row 6: Table column headers

This inconsistency wastes vertical space and reduces the visible list area.

**Issue 2: No Infinite Scroll**

Currently, lists either:
- Load all data at once (OASIS Events: 100-200 items max)
- Have pagination but no infinite scroll (Governance History has "Load More" but limited)
- Have fixed limits (VTID Ledger: 50-200 items max)

Users cannot scroll endlessly through historical data.

---

## 2. Scope

### 2.1 Affected Views

| View | File Location | Current State | Changes Required |
|------|--------------|---------------|------------------|
| OASIS Events | `app.js:10726` | 6-row header, no pagination | Layout + infinite scroll |
| VTID Ledger | `app.js:11883` | 4-row header, no pagination | Layout + infinite scroll |
| Governance History | `app.js:9359` | 3-row header, has "Load More" | Infinite scroll enhancement |
| Command Hub Events | `app.js` | Similar to OASIS Events | Layout + infinite scroll |

### 2.2 Out of Scope

- Detail drawer/panel layouts
- Mobile responsiveness (future enhancement)
- Virtual scrolling optimization (future enhancement)

---

## 3. Standardized 3-Row Header Layout

### 3.1 Row Structure

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ROW 1: Tab Navigation                                                    │
│ ┌─────┐ ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌─────────────┐            │
│ │Events│ │VTID Ledger│ │ Entities │ │ Streams │ │ Command Log │            │
│ └─────┘ └─────────┘ └──────────┘ └─────────┘ └─────────────┘            │
├─────────────────────────────────────────────────────────────────────────┤
│ ROW 2: Toolbar (Filters + Controls + Metadata)                          │
│ ┌──────────────┐ ┌──────────────┐ ┌────────────┐    ┌──────┐  50 events │
│ │ All Topics ▼ │ │ All Status ▼ │ │ Auto: ON   │    │ LIVE │            │
│ └──────────────┘ └──────────────┘ └────────────┘    └──────┘            │
├─────────────────────────────────────────────────────────────────────────┤
│ ROW 3: Table Column Headers                                              │
│ Severity │ Timestamp │ Topic │ VTID │ Service │ Status │ Message        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│                         SCROLLABLE LIST AREA                             │
│                                                                          │
│  ● Jan 18, 05:26 PM  governance.control.updated  VTID-01181  SUCCESS    │
│  ● Jan 18, 05:23 PM  vtid.tts.failure            VTID-01155  ERROR      │
│  ● Jan 18, 05:23 PM  memory.write.assistant...   VTID-01105  SUCCESS    │
│                              ...                                         │
│                                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                        ┌─────────────┐                                   │
│                        │  Load More  │                                   │
│                        └─────────────┘                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Row 1: Tab Navigation

- **Content:** Horizontal tab buttons for sub-navigation
- **Height:** Fixed (~48px)
- **Behavior:** Standard tab switching, no changes required

### 3.3 Row 2: Toolbar

All controls consolidated into a single horizontal row:

| Element | Position | Description |
|---------|----------|-------------|
| Filters | Left | Dropdowns arranged horizontally (inline-flex) |
| Toggle Controls | Center-left | Auto-refresh toggle, other action buttons |
| Status Indicator | Center-right | "LIVE" pill when auto-refresh active |
| Metadata | Right | Item count (e.g., "50 events") |

**CSS Layout:**
```css
.list-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  flex-wrap: wrap; /* Allow wrapping on narrow screens */
}

.list-toolbar__filters {
  display: flex;
  gap: 8px;
  align-items: center;
}

.list-toolbar__controls {
  display: flex;
  gap: 8px;
  align-items: center;
}

.list-toolbar__metadata {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 13px;
}
```

### 3.4 Row 3: Table Column Headers

- **Content:** Column headers for the data table
- **Height:** Fixed (~40px)
- **Position:** Sticky at top of scroll container
- **Behavior:** Remains visible while scrolling list

**CSS for Sticky Headers:**
```css
.list-table thead {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--bg-secondary);
}
```

---

## 4. Infinite Scroll Implementation

### 4.1 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (app.js)                         │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    List View State                           ││
│  │  {                                                           ││
│  │    items: [...],           // All loaded items               ││
│  │    loading: false,         // Loading indicator              ││
│  │    hasMore: true,          // More data available            ││
│  │    pagination: {                                             ││
│  │      limit: 50,            // Items per page                 ││
│  │      offset: 0,            // Current offset (cursor)        ││
│  │      total: null           // Total count (optional)         ││
│  │    }                                                         ││
│  │  }                                                           ││
│  └─────────────────────────────────────────────────────────────┘│
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Scroll Container + Observer                     ││
│  │                                                              ││
│  │  - IntersectionObserver watches "Load More" button           ││
│  │  - Triggers fetch when button enters viewport                ││
│  │  - Manual click also triggers fetch                          ││
│  └─────────────────────────────────────────────────────────────┘│
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                     API Request                              ││
│  │  GET /api/v1/{resource}?limit=50&offset={offset}&...         ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Backend (API)                             │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   Response Format                            ││
│  │  {                                                           ││
│  │    data: [...],            // Items for this page            ││
│  │    pagination: {                                             ││
│  │      limit: 50,                                              ││
│  │      offset: 50,           // Next offset                    ││
│  │      has_more: true,       // More data available            ││
│  │      total: 1234           // Total count (optional)         ││
│  │    }                                                         ││
│  │  }                                                           ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 State Management

Each list view will maintain pagination state:

```javascript
// State structure for each list view
state.oasisEvents = {
  items: [],
  loading: false,
  error: null,
  fetched: false,
  filters: { topic: '', status: '' },
  autoRefreshEnabled: true,
  pagination: {
    limit: 50,
    offset: 0,
    hasMore: true,
    total: null
  }
};
```

### 4.3 Fetch Function Pattern

```javascript
async function fetchOasisEventsPage(append = false) {
  const { pagination, filters } = state.oasisEvents;

  if (state.oasisEvents.loading) return;
  if (!append && !pagination.hasMore) return;

  state.oasisEvents.loading = true;
  updateLoadMoreButton('loading');

  try {
    const params = new URLSearchParams({
      limit: pagination.limit,
      offset: append ? pagination.offset : 0,
      ...filters
    });

    const response = await fetch(`/api/v1/oasis/events?${params}`);
    const result = await response.json();

    if (append) {
      // Append new items to existing list
      state.oasisEvents.items = [...state.oasisEvents.items, ...result.data];
    } else {
      // Replace items (initial load or filter change)
      state.oasisEvents.items = result.data;
    }

    // Update pagination state
    state.oasisEvents.pagination = {
      ...pagination,
      offset: pagination.offset + result.data.length,
      hasMore: result.pagination?.has_more ?? result.data.length === pagination.limit,
      total: result.pagination?.total ?? null
    };

    state.oasisEvents.fetched = true;
    state.oasisEvents.error = null;

  } catch (error) {
    state.oasisEvents.error = error.message;
  } finally {
    state.oasisEvents.loading = false;
    renderOasisEventsList();
  }
}
```

### 4.4 Load More Button Component

```javascript
function renderLoadMoreButton(containerSelector, viewState, loadMoreFn) {
  const container = document.querySelector(containerSelector);
  if (!container) return;

  // Remove existing button
  const existingBtn = container.querySelector('.load-more-container');
  if (existingBtn) existingBtn.remove();

  // Don't render if no more data
  if (!viewState.pagination.hasMore) return;

  const loadMoreContainer = document.createElement('div');
  loadMoreContainer.className = 'load-more-container';

  const button = document.createElement('button');
  button.className = 'load-more-btn';
  button.disabled = viewState.loading;

  if (viewState.loading) {
    button.innerHTML = `
      <span class="spinner"></span>
      Loading...
    `;
  } else {
    button.textContent = 'Load More';
    button.onclick = () => loadMoreFn(true); // append=true
  }

  loadMoreContainer.appendChild(button);
  container.appendChild(loadMoreContainer);

  // Setup IntersectionObserver for auto-load
  setupInfiniteScrollObserver(loadMoreContainer, viewState, loadMoreFn);
}
```

### 4.5 Intersection Observer for Auto-Loading

```javascript
const infiniteScrollObservers = new Map();

function setupInfiniteScrollObserver(element, viewState, loadMoreFn) {
  const viewKey = element.closest('[data-view]')?.dataset.view;
  if (!viewKey) return;

  // Disconnect existing observer for this view
  if (infiniteScrollObservers.has(viewKey)) {
    infiniteScrollObservers.get(viewKey).disconnect();
  }

  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (entry.isIntersecting && !viewState.loading && viewState.pagination.hasMore) {
        loadMoreFn(true); // append=true
      }
    },
    {
      root: element.closest('.list-scroll-container'),
      rootMargin: '100px', // Start loading 100px before button is visible
      threshold: 0.1
    }
  );

  observer.observe(element);
  infiniteScrollObservers.set(viewKey, observer);
}
```

### 4.6 CSS for Load More Component

```css
.load-more-container {
  display: flex;
  justify-content: center;
  padding: 24px 16px;
  border-top: 1px solid var(--border-color);
}

.load-more-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 24px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.load-more-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--border-hover);
}

.load-more-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.load-more-btn .spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-color);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
```

---

## 5. View-Specific Changes

### 5.1 OASIS Events View

**Current Layout (6 rows):**
```
Row 1: Tabs
Row 2: Auto-refresh toggle
Row 3: Topic dropdown
Row 4: Status dropdown
Row 5: LIVE indicator
Row 6: Table headers
```

**New Layout (3 rows):**
```
Row 1: Tabs (unchanged)
Row 2: [All Topics ▼] [All Status ▼] [Auto-refresh: ON] [LIVE pill] | 50 events
Row 3: Table headers (Severity | Timestamp | Topic | VTID | Service | Status | Message)
```

**Changes Required:**
1. Consolidate rows 2-5 into single toolbar row
2. Add pagination state to `state.oasisEvents`
3. Modify `fetchOasisEvents()` to support pagination
4. Add "Load More" button after table
5. Implement IntersectionObserver for auto-load

**Function Changes:**
- `renderOasisEventsView()` - Restructure HTML output
- `fetchOasisEvents()` → `fetchOasisEventsPage(append)` - Add pagination
- New: `renderOasisEventsLoadMore()`

### 5.2 VTID Ledger View

**Current Layout (4 rows):**
```
Row 1: Tabs
Row 2: View label (OASIS_VTID_LEDGER_ACTIVE)
Row 3: Description + count
Row 4: Table headers
```

**New Layout (3 rows):**
```
Row 1: Tabs (unchanged)
Row 2: View: [OASIS_VTID_LEDGER_ACTIVE ▼] | Loaded 50 VTIDs from Ledger
Row 3: Table headers (VTID | Title | Stage | Status | Attention | Last Update)
```

**Changes Required:**
1. Merge view selector and count into toolbar row
2. Add pagination state to `state.vtidLedger`
3. Modify API calls to support offset pagination
4. Add "Load More" button after table
5. Implement IntersectionObserver

### 5.3 Governance History View

**Current Layout (3 rows):** Already compliant

**Changes Required:**
1. Enhance existing "Load More" with IntersectionObserver for auto-load
2. Ensure consistent styling with other views

### 5.4 Command Hub Events View

Same changes as OASIS Events View.

---

## 6. API Changes

### 6.1 Required Response Format

All list endpoints must support:

**Request Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 50 | Items per page |
| `offset` | integer | 0 | Starting offset |
| `...filters` | various | - | View-specific filters |

**Response Format:**
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

### 6.2 Endpoint Updates Required

| Endpoint | Current State | Changes Needed |
|----------|--------------|----------------|
| `GET /api/v1/oasis/events` | limit only | Add offset, return pagination object |
| `GET /api/v1/oasis/vtid-ledger` | limit only (max 200) | Add offset, remove max limit, return pagination |
| `GET /api/v1/governance/history` | Has pagination | Already compliant |

---

## 7. Implementation Checklist

### Phase 1: Shared Infrastructure
- [ ] Create shared toolbar CSS class `.list-toolbar`
- [ ] Create shared load more component
- [ ] Create IntersectionObserver utility function
- [ ] Update CSS variables for consistent styling

### Phase 2: OASIS Events View
- [ ] Restructure `renderOasisEventsView()` to 3-row layout
- [ ] Update toolbar to inline filters + controls
- [ ] Add pagination state
- [ ] Update `fetchOasisEvents()` for pagination
- [ ] Add "Load More" button
- [ ] Implement auto-load with IntersectionObserver
- [ ] Update API endpoint if needed

### Phase 3: VTID Ledger View
- [ ] Restructure `renderOasisVtidLedgerView()` to 3-row layout
- [ ] Update toolbar layout
- [ ] Add pagination state
- [ ] Update fetch function for pagination
- [ ] Add "Load More" button
- [ ] Implement auto-load
- [ ] Update API endpoint

### Phase 4: Governance History View
- [ ] Add IntersectionObserver to existing "Load More"
- [ ] Ensure consistent styling

### Phase 5: Command Hub Events View
- [ ] Apply same changes as OASIS Events

### Phase 6: Testing
- [ ] Test infinite scroll with large datasets
- [ ] Test filter changes reset pagination
- [ ] Test scroll position preservation
- [ ] Test auto-refresh interaction with pagination
- [ ] Test error handling during load more
- [ ] Test empty states

---

## 8. Edge Cases & Considerations

### 8.1 Auto-Refresh + Pagination

For views with auto-refresh (OASIS Events):
- Auto-refresh should **prepend** new items to the list
- Pagination offset should account for prepended items
- Consider showing "X new events" banner instead of auto-prepending

### 8.2 Filter Changes

When filters change:
- Reset pagination offset to 0
- Clear existing items
- Fetch fresh data
- Disconnect and reconnect IntersectionObserver

### 8.3 Error Handling

- Show inline error message below list on load more failure
- Provide retry button
- Do not clear existing items on error

### 8.4 Loading States

- Initial load: Show skeleton rows
- Load more: Show spinner in button, keep existing items visible
- Prevent duplicate requests (check `loading` state)

### 8.5 Empty States

- Show "No items found" message when list is empty
- Hide "Load More" button when `hasMore: false`

---

## 9. Visual Reference

### Before (OASIS Events - 6 rows):
```
┌────────────────────────────────────────────────────────────┐
│ Events | VTID Ledger | Entities | Streams | Command Log   │ ← Row 1
├────────────────────────────────────────────────────────────┤
│ Auto-refresh (5s): [ON]                                    │ ← Row 2
├────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────┐   │ ← Row 3
│ │ All Topics                                        ▼ │   │
│ └─────────────────────────────────────────────────────┘   │
├────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────┐   │ ← Row 4
│ │ All Status                                        ▼ │   │
│ └─────────────────────────────────────────────────────┘   │
├────────────────────────────────────────────────────────────┤
│ ● LIVE - Auto-refreshing                                   │ ← Row 5
├────────────────────────────────────────────────────────────┤
│ Severity | Timestamp | Topic | VTID | Service | Status    │ ← Row 6
├────────────────────────────────────────────────────────────┤
│                     List items...                          │
└────────────────────────────────────────────────────────────┘
```

### After (OASIS Events - 3 rows):
```
┌────────────────────────────────────────────────────────────┐
│ Events | VTID Ledger | Entities | Streams | Command Log   │ ← Row 1
├────────────────────────────────────────────────────────────┤
│ [All Topics▼] [All Status▼] [Auto: ON] ● LIVE   50 events │ ← Row 2
├────────────────────────────────────────────────────────────┤
│ Severity | Timestamp | Topic | VTID | Service | Status    │ ← Row 3
├────────────────────────────────────────────────────────────┤
│                                                            │
│                     List items...                          │
│                                                            │
├────────────────────────────────────────────────────────────┤
│                    [ Load More ]                           │
└────────────────────────────────────────────────────────────┘
```

---

## 10. Success Criteria

1. **Layout Consistency:** All list views follow the 3-row header pattern
2. **Infinite Scroll:** Users can load unlimited historical data
3. **Performance:** No degradation with large lists (1000+ items)
4. **UX:** Smooth loading experience with proper feedback
5. **Compatibility:** Works with existing auto-refresh functionality
6. **Maintainability:** Shared components reduce code duplication

---

## 11. Appendix: Affected Files

| File | Purpose |
|------|---------|
| `services/gateway/src/frontend/command-hub/app.js` | Main frontend application |
| `services/gateway/src/frontend/command-hub/app.css` | Styles (if separate) |
| `services/gateway/src/routes/events.ts` | Events API route |
| `services/gateway/src/routes/oasis-vtid-ledger.ts` | VTID Ledger API route |
| `services/gateway/src/controllers/governance-controller.ts` | Governance API controller |
