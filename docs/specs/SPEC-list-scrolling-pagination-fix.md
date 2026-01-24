# Specification: Universal List Scrolling and Pagination Fix

**VTID:** VTID-01211
**Status:** Draft
**Author:** Claude
**Date:** 2026-01-24
**Priority:** CRITICAL

---

## 1. Executive Summary

**PROBLEM:** Multiple list screens in Vitana DEV are NOT scrollable and lack "Load More" pagination buttons, making them unusable when data exceeds the viewport.

**AFFECTED SCREENS:**
- Agents > Registered Agents
- Agents > Skills
- Agents > Pipelines
- Agents > Telemetry
- Governance > Rules
- Governance > Categories
- Governance > Evaluations
- Governance > Violations
- Governance > Proposals
- Governance > Controls

**REFERENCE IMPLEMENTATION:** OASIS > Events screen (WORKING CORRECTLY)

**UX DESIGN RULE:** Every screen that displays a list MUST have:
1. **Scrollable content area** with proper overflow handling
2. **"Load More" button** at the bottom of the scrollable content
3. **Pagination state management** (limit, offset, hasMore)

---

## 2. Universal 3-Row Structure

All list screens MUST follow this exact structure:

```
┌────────────────────────────────────────────────────────────┐
│ AUTOPILOT | OPERATOR | PUBLISH          ● LIVE    ↻       │ ← Row 1: Global top bar (DO NOT CHANGE)
├────────────────────────────────────────────────────────────┤
│ Tab1 | Tab2 | Tab3 | Tab4 | Tab5                          │ ← Row 2: Section tab navigation (DO NOT CHANGE)
├────────────────────────────────────────────────────────────┤
│ [Filters...] [Search...]                         XX items │ ← Row 3: Toolbar (filters left, count right)
├────────────────────────────────────────────────────────────┤
│ Column1 | Column2 | Column3 | Column4                     │ ← Sticky table header
├────────────────────────────────────────────────────────────┤
│ Row 1 data...                                             │
│ Row 2 data...                                             │
│ Row 3 data...                                     SCROLL  │ ← Scrollable content area
│ ...                                                  ↓    │
├────────────────────────────────────────────────────────────┤
│                    [ Load More ]                          │ ← Load More button (inside scroll area)
└────────────────────────────────────────────────────────────┘
```

---

## 3. Reference Implementation: OASIS Events

**File:** `services/gateway/src/frontend/command-hub/app.js`

### 3.1 State Structure (Lines 2650-2670)

```javascript
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
    pagination: {
        limit: 50,
        offset: 0,
        hasMore: true
    }
}
```

### 3.2 Render Pattern (Lines 12895-13064)

```javascript
function renderOasisEventsView() {
    var container = document.createElement('div');
    container.className = 'oasis-events-view';

    // Row 3: Toolbar
    var toolbar = document.createElement('div');
    toolbar.className = 'list-toolbar';

    var filters = document.createElement('div');
    filters.className = 'list-toolbar__filters';
    // ... add filter dropdowns ...

    var metadata = document.createElement('div');
    metadata.className = 'list-toolbar__metadata';
    metadata.textContent = items.length + ' events';

    toolbar.appendChild(filters);
    toolbar.appendChild(metadata);
    container.appendChild(toolbar);

    // Scrollable Content
    var content = document.createElement('div');
    content.className = 'list-scroll-container oasis-events-content';

    // Table with sticky header
    var table = document.createElement('table');
    table.className = 'list-table oasis-events-table';
    // ... build table ...
    content.appendChild(table);

    // Load More button (INSIDE scroll container)
    if (state.oasisEvents.pagination.hasMore || state.oasisEvents.loading) {
        var loadMoreContainer = document.createElement('div');
        loadMoreContainer.className = 'load-more-container';

        var loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'load-more-btn';
        loadMoreBtn.textContent = state.oasisEvents.loading ? 'Loading...' : 'Load More';
        loadMoreBtn.onclick = function() { loadMoreOasisEvents(); };

        loadMoreContainer.appendChild(loadMoreBtn);
        content.appendChild(loadMoreContainer);
    }

    container.appendChild(content);
    return container;
}
```

### 3.3 Fetch with Pagination (Lines 2950-3010)

```javascript
async function fetchOasisEvents(filters, append) {
    if (state.oasisEvents.loading) return;
    if (append && !state.oasisEvents.pagination.hasMore) return;

    state.oasisEvents.loading = true;
    renderApp();

    try {
        var pagination = state.oasisEvents.pagination;
        var offset = append ? pagination.offset : 0;

        var params = new URLSearchParams({
            limit: pagination.limit,
            offset: offset
        });

        var response = await fetch('/api/v1/oasis/events?' + params);
        var result = await response.json();

        if (append) {
            state.oasisEvents.items = [...state.oasisEvents.items, ...result.data];
        } else {
            state.oasisEvents.items = result.data;
        }

        state.oasisEvents.pagination = {
            limit: pagination.limit,
            offset: offset + result.data.length,
            hasMore: result.pagination?.has_more ?? result.data.length === pagination.limit
        };
    } catch (error) {
        state.oasisEvents.error = error.message;
    } finally {
        state.oasisEvents.loading = false;
        renderApp();
    }
}

function loadMoreOasisEvents() {
    fetchOasisEvents(state.oasisEvents.filters, true);
}
```

---

## 4. Required CSS Classes

**File:** `services/gateway/src/frontend/command-hub/styles.css`

These classes already exist (Lines 11259-11507) and MUST be used:

```css
/* Row 3 Toolbar */
.list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border, #333);
  background: var(--color-bg-secondary, #1a1a2e);
  min-height: 48px;
  gap: 12px;
}

.list-toolbar__filters {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.list-toolbar__metadata {
  color: var(--color-text-secondary, #888);
  font-size: 13px;
  white-space: nowrap;
}

/* Scrollable Content Container */
.list-scroll-container {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

/* Load More Button */
.load-more-container {
  display: flex;
  justify-content: center;
  padding: 24px 16px;
  border-top: 1px solid var(--color-border, #333);
}

.load-more-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 24px;
  min-width: 120px;
  background: var(--color-bg-tertiary, #252540);
  border: 1px solid var(--color-border, #333);
  border-radius: 6px;
  color: var(--color-text-primary, #fff);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.load-more-btn:hover:not(:disabled) {
  background: var(--color-bg-hover, #2a2a4a);
  border-color: var(--color-border-hover, #555);
}

.load-more-btn.loading::after {
  content: '';
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-left: 8px;
  border: 2px solid var(--color-border, #333);
  border-top-color: var(--color-accent, #4a9eff);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
```

---

## 5. Screen-by-Screen Fixes

### 5.1 Agents > Registered Agents

**Current State:** NO scrolling, NO pagination, loads all data at once

**Location:** `renderRegisteredAgentsView()` (Lines 9432-9512)

**Changes Required:**

| Change | Description |
|--------|-------------|
| ADD | Pagination state to `state.agentsRegistry.registeredAgents` |
| ADD | `list-scroll-container` class to content wrapper |
| ADD | Load More button at bottom |
| MODIFY | `fetchAgentsRegistryData()` to support offset/limit |

**Target State:**
```javascript
state.agentsRegistry = {
    // ... existing fields ...
    registeredAgents: {
        items: [],
        loading: false,
        pagination: {
            limit: 50,
            offset: 0,
            hasMore: true
        }
    }
};
```

**Render Pattern:**
```javascript
function renderRegisteredAgentsView() {
    var container = document.createElement('div');
    container.className = 'agents-registry-view';

    // Row 3: Toolbar
    var toolbar = document.createElement('div');
    toolbar.className = 'list-toolbar';
    // ... filters on left, count on right ...
    container.appendChild(toolbar);

    // Scrollable Content
    var content = document.createElement('div');
    content.className = 'list-scroll-container';

    // Health cards section
    // ... existing health cards ...

    // Subagents table
    // ... existing table ...

    // Load More button
    if (state.agentsRegistry.registeredAgents.pagination.hasMore) {
        var loadMoreContainer = document.createElement('div');
        loadMoreContainer.className = 'load-more-container';
        // ... button ...
        content.appendChild(loadMoreContainer);
    }

    container.appendChild(content);
    return container;
}
```

---

### 5.2 Agents > Skills

**Current State:** NO scrolling, NO pagination, renders `renderSkillsTable()` without limit

**Location:** `renderSkillsTable()` (Lines 9518-9561)

**Changes Required:**

| Change | Description |
|--------|-------------|
| ADD | Pagination state to `state.agentsRegistry.skills` |
| ADD | `list-scroll-container` class to table wrapper |
| ADD | Load More button at bottom |
| ADD | Item count in toolbar |
| MODIFY | Skills fetch to support offset/limit |

**Target State:**
```javascript
state.agentsRegistry.skills = {
    items: [],
    loading: false,
    pagination: {
        limit: 50,
        offset: 0,
        hasMore: true
    }
};
```

---

### 5.3 Agents > Pipelines

**Current State:** Has `overflow-y: auto` on main container, but NO Load More button

**Location:** `renderPipelinesView()` (Lines 10042-10350)

**Changes Required:**

| Change | Description |
|--------|-------------|
| ADD | Pagination state |
| ADD | Load More button at bottom of table |
| ADD | Proper `list-scroll-container` class |
| MODIFY | Fetch function to support offset/limit |

---

### 5.4 Agents > Telemetry

**Current State:** NO scrolling, NO pagination

**Location:** `renderTelemetryView()` (Lines 10350-10406)

**Changes Required:**

| Change | Description |
|--------|-------------|
| ADD | Pagination state to `state.agentsTelemetry` |
| ADD | `list-scroll-container` class |
| ADD | Load More button |
| ADD | Item count in toolbar ("18 events" as shown in screenshot) |
| MODIFY | Fetch function to support offset/limit |

**Target State:**
```javascript
state.agentsTelemetry = {
    items: [],
    loading: false,
    error: null,
    filters: { /* ... */ },
    pagination: {
        limit: 50,
        offset: 0,
        hasMore: true
    }
};
```

---

### 5.5 Governance > Rules

**Current State:** Has table-wrapper with `overflow: auto`, but NO Load More button

**Location:** `renderGovernanceRulesView()` (Lines 10783-11256)

**Current CSS Problem (Lines 2893-2999):**
```css
.governance-rules-container {
    overflow: hidden;  /* WRONG - blocks scrolling */
}
.governance-rules-table-wrapper {
    overflow: auto;    /* Scrolling in wrong place */
}
```

**Changes Required:**

| Change | Description |
|--------|-------------|
| ADD | Pagination state to `state.governanceRules` |
| CHANGE | State from array to object with items/pagination |
| ADD | `list-scroll-container` class to content |
| ADD | Load More button at bottom |
| FIX | CSS `overflow: hidden` to proper flex layout |

**Target State:**
```javascript
// BEFORE (WRONG):
governanceRules: [],

// AFTER (CORRECT):
governanceRules: {
    items: [],
    loading: false,
    error: null,
    filters: {
        search: '',
        level: '',
        category: '',
        source: ''
    },
    pagination: {
        limit: 50,
        offset: 0,
        hasMore: true
    }
}
```

---

### 5.6 Governance > Categories

**Current State:** Two-column layout, NO pagination, loads all at once

**Location:** `renderGovernanceCategoriesView()` (Lines 11940-12140)

**Changes Required:**

| Change | Description |
|--------|-------------|
| ADD | Pagination state |
| ADD | `list-scroll-container` to category list |
| ADD | Load More button |

---

### 5.7 Governance > Evaluations

**Current State:** Simple array-based state, NO pagination

**Location:** `renderGovernanceEvaluationsView()` (Lines 11256-11522)

**Changes Required:**

| Change | Description |
|--------|-------------|
| ADD | Pagination state |
| ADD | `list-scroll-container` class |
| ADD | Load More button |

---

### 5.8 Governance > Violations

**Current State:** NO pagination

**Location:** Part of governance section

**Changes Required:**

| Change | Description |
|--------|-------------|
| ADD | Pagination state |
| ADD | `list-scroll-container` class |
| ADD | Load More button |

---

### 5.9 Governance > Proposals

**Current State:** NO pagination

**Location:** Part of governance section

**Changes Required:**

| Change | Description |
|--------|-------------|
| ADD | Pagination state |
| ADD | `list-scroll-container` class |
| ADD | Load More button |

---

### 5.10 Governance > Controls

**Current State:** NO pagination, loads all controls at once

**Location:** `renderGovernanceControlsView()` (Lines 12328-12675)

**Changes Required:**

| Change | Description |
|--------|-------------|
| ADD | Pagination state |
| ADD | `list-scroll-container` class |
| ADD | Load More button |

---

### 5.11 Governance > History (ALREADY HAS PAGINATION - VERIFY ONLY)

**Current State:** HAS pagination (Lines 11487-11505), HAS Load More button (Lines 11745-11760)

**Verify:**
- [ ] Uses standard `list-scroll-container` class
- [ ] Load More button styled consistently
- [ ] Scrolling works correctly

---

## 6. Implementation Checklist

### Phase 1: CSS Foundation
- [ ] Verify `.list-scroll-container` class exists in styles.css
- [ ] Verify `.list-toolbar` class exists
- [ ] Verify `.load-more-container` and `.load-more-btn` classes exist
- [ ] Fix any conflicting `overflow: hidden` rules on parent containers

### Phase 2: Agents Section
- [ ] Add pagination state to `agentsRegistry.registeredAgents`
- [ ] Add pagination state to `agentsRegistry.skills`
- [ ] Add pagination state to pipelines
- [ ] Add pagination state to telemetry
- [ ] Implement `loadMoreRegisteredAgents()` function
- [ ] Implement `loadMoreSkills()` function
- [ ] Implement `loadMorePipelines()` function
- [ ] Implement `loadMoreTelemetry()` function
- [ ] Add Load More buttons to all 4 views
- [ ] Verify scrolling works on all 4 views

### Phase 3: Governance Section
- [ ] Convert `governanceRules` from array to object with pagination
- [ ] Add pagination state to categories
- [ ] Add pagination state to evaluations
- [ ] Add pagination state to violations
- [ ] Add pagination state to proposals
- [ ] Add pagination state to controls
- [ ] Implement `loadMore*()` functions for all views
- [ ] Add Load More buttons to all views
- [ ] Verify scrolling works on all views

### Phase 4: API Updates
- [ ] Add `offset` and `limit` params to registered agents API
- [ ] Add `offset` and `limit` params to skills API
- [ ] Add `offset` and `limit` params to pipelines API
- [ ] Add `offset` and `limit` params to telemetry API
- [ ] Add `offset` and `limit` params to governance rules API
- [ ] Add `offset` and `limit` params to governance categories API
- [ ] Add `offset` and `limit` params to governance evaluations API
- [ ] Add `offset` and `limit` params to governance violations API
- [ ] Add `offset` and `limit` params to governance proposals API
- [ ] Add `offset` and `limit` params to governance controls API

### Phase 5: Testing
- [ ] Test each screen with 100+ items
- [ ] Test Load More button shows loading state
- [ ] Test Load More button hides when no more data
- [ ] Test filter changes reset pagination
- [ ] Test scrolling is smooth
- [ ] Test sticky headers work

---

## 7. Files to Modify

| File | Changes |
|------|---------|
| `services/gateway/src/frontend/command-hub/app.js` | All render functions, state definitions, fetch functions |
| `services/gateway/src/frontend/command-hub/styles.css` | Fix overflow issues, add any missing classes |
| `services/gateway/src/routes/agents.ts` | Add pagination to agents endpoints |
| `services/gateway/src/routes/governance.ts` | Add pagination to governance endpoints |

---

## 8. Code Template

Use this template for ALL list views:

```javascript
// === STATE TEMPLATE ===
state.moduleName = {
    items: [],
    loading: false,
    error: null,
    fetched: false,
    filters: { /* screen-specific filters */ },
    pagination: {
        limit: 50,
        offset: 0,
        hasMore: true
    }
};

// === FETCH TEMPLATE ===
async function fetchModuleData(append) {
    if (state.moduleName.loading) return;
    if (append && !state.moduleName.pagination.hasMore) return;

    state.moduleName.loading = true;
    renderApp();

    try {
        var pagination = state.moduleName.pagination;
        var offset = append ? pagination.offset : 0;

        var params = new URLSearchParams({
            limit: pagination.limit,
            offset: offset
        });
        // Add filters to params...

        var response = await fetch('/api/v1/endpoint?' + params);
        var result = await response.json();

        if (append) {
            state.moduleName.items = [...state.moduleName.items, ...result.data];
        } else {
            state.moduleName.items = result.data;
        }

        state.moduleName.pagination = {
            limit: pagination.limit,
            offset: offset + result.data.length,
            hasMore: result.pagination?.has_more ?? result.data.length === pagination.limit
        };

        state.moduleName.fetched = true;
        state.moduleName.error = null;
    } catch (error) {
        state.moduleName.error = error.message;
    } finally {
        state.moduleName.loading = false;
        renderApp();
    }
}

function loadMoreModuleData() {
    fetchModuleData(true);
}

function handleModuleFilterChange() {
    state.moduleName.pagination.offset = 0;
    state.moduleName.pagination.hasMore = true;
    fetchModuleData(false);
}

// === RENDER TEMPLATE ===
function renderModuleView() {
    var container = document.createElement('div');
    container.className = 'module-view';

    // Row 3: Toolbar
    var toolbar = document.createElement('div');
    toolbar.className = 'list-toolbar';

    var filters = document.createElement('div');
    filters.className = 'list-toolbar__filters';
    // Add filter dropdowns/search...

    var metadata = document.createElement('div');
    metadata.className = 'list-toolbar__metadata';
    metadata.textContent = state.moduleName.items.length + ' items';

    toolbar.appendChild(filters);
    toolbar.appendChild(metadata);
    container.appendChild(toolbar);

    // Scrollable Content
    var content = document.createElement('div');
    content.className = 'list-scroll-container';

    // Table
    var table = document.createElement('table');
    table.className = 'list-table';
    // ... build thead and tbody ...
    content.appendChild(table);

    // Load More button (ALWAYS inside scroll container)
    if (state.moduleName.pagination.hasMore || state.moduleName.loading) {
        var loadMoreContainer = document.createElement('div');
        loadMoreContainer.className = 'load-more-container';

        var loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'load-more-btn' + (state.moduleName.loading ? ' loading' : '');
        loadMoreBtn.disabled = state.moduleName.loading;
        loadMoreBtn.textContent = state.moduleName.loading ? 'Loading...' : 'Load More';
        loadMoreBtn.onclick = function() { loadMoreModuleData(); };

        loadMoreContainer.appendChild(loadMoreBtn);
        content.appendChild(loadMoreContainer);
    }

    container.appendChild(content);
    return container;
}
```

---

## 9. API Response Template

All list APIs MUST return pagination metadata:

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

---

## 10. Success Criteria

1. **ALL list screens are scrollable** - Content does not overflow viewport
2. **ALL list screens have Load More button** - Visible when more data exists
3. **Load More shows loading state** - Button text changes, spinner appears
4. **Load More hides when exhausted** - Button disappears when `hasMore: false`
5. **Filters reset pagination** - Changing filters resets offset to 0
6. **Consistent styling** - All screens use same `.list-toolbar`, `.list-scroll-container`, `.load-more-btn` classes
7. **Sticky headers** - Table headers stay visible while scrolling
8. **Performance** - Smooth scrolling with 1000+ items loaded

---

## 11. UX Design Rule (MANDATORY)

**EVERY SCREEN THAT DISPLAYS A LIST MUST HAVE:**

1. **Row 3 Toolbar** - Filters on left, item count on right
2. **Scrollable Content Area** - Using `.list-scroll-container` class
3. **Sticky Table Headers** - Headers visible while scrolling
4. **Load More Button** - At the bottom of scrollable content
5. **Pagination State** - `{ limit: 50, offset: 0, hasMore: true }`
6. **Fetch with Append** - `fetchData(append)` function pattern

**NO EXCEPTIONS. ENFORCE THIS ON EVERY NEW SCREEN.**

---

## 12. Visual Reference

Screenshot showing correct implementation (OASIS > Events):

- Row 3: `[All Topics ▼] [All Status ▼]` on left, `50 events` on right
- Scrollable table with sticky header
- "Load More" button at bottom
- Clean, consistent styling

This is the TEMPLATE for all other screens.
