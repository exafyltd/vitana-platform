# Specification: Universal List Scrolling and Pagination Fix

**VTID:** VTID-01211
**Status:** Draft
**Author:** Claude
**Date:** 2026-01-24
**Priority:** CRITICAL
**Scope:** FRONTEND ONLY

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

**SCOPE:** This is a **FRONTEND-ONLY** fix. No backend API changes required.

---

## 2. UX Design Rule (MANDATORY)

**EVERY SCREEN THAT DISPLAYS A LIST MUST HAVE:**

1. **Scrollable content area** using `.list-scroll-container` class
2. **Sticky table headers** so column names stay visible while scrolling
3. **Item count** displayed in Row 3 toolbar
4. **Load More button** for screens with paginated APIs

---

## 3. Universal 3-Row Structure

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

## 4. Screen Classification

### 4.1 Screens WITH Pagination (Add Load More)

These screens have APIs that already support `limit`/`offset`:

| Screen | API Endpoint | Has Pagination |
|--------|--------------|----------------|
| OASIS Events | `/api/v1/oasis/events` | ✅ YES |
| Telemetry | `/api/v1/agents/telemetry` | ✅ YES |
| Governance History | `/api/v1/governance/history` | ✅ YES |
| Governance Evaluations | `/api/v1/governance/evaluations` | ✅ YES |

### 4.2 Screens WITHOUT Pagination (Scrolling Only)

These screens return small/static data sets - just add scrolling:

| Screen | Reason | Action |
|--------|--------|--------|
| Registered Agents | Static list (5-6 subagents) | Add scroll container |
| Skills | Static registry (~15 skills) | Add scroll container |
| Pipelines | VTID ledger view | Add scroll container |
| Governance Rules | Loaded from config (~66 rules) | Add scroll container |
| Governance Categories | Small set (~10 categories) | Add scroll container |
| Governance Controls | Moderate set | Add scroll container |
| Governance Violations | From database | Add scroll container + Load More |
| Governance Proposals | From database | Add scroll container + Load More |

---

## 5. Required CSS Fix

**Problem:** Parent containers have `overflow: hidden` which blocks scrolling.

**File:** `services/gateway/src/frontend/command-hub/styles.css`

### 5.1 Fix Agents Container

```css
/* BEFORE (BROKEN) */
.agents-registry-container {
  padding: 16px 24px;
  max-width: 1400px;
  /* NO overflow - content overflows viewport */
}

/* AFTER (FIXED) */
.agents-registry-container {
  padding: 16px 24px;
  max-width: 1400px;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.agents-registry-content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
```

### 5.2 Fix Governance Container

```css
/* BEFORE (BROKEN) */
.governance-rules-container {
  padding: 1.5rem;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;  /* BLOCKS child scrolling */
}

/* AFTER (FIXED) */
.governance-rules-container {
  padding: 1.5rem;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;  /* Allow flex shrinking */
}

.governance-rules-content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
```

---

## 6. Required CSS Classes

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

## 7. Screen-by-Screen Changes

### 7.1 Agents > Registered Agents

**File:** `app.js` - `renderRegisteredAgentsView()` (Line ~9432)

**Changes:**
1. Wrap content in `.list-scroll-container` div
2. Add item count to toolbar
3. NO Load More needed (static data)

### 7.2 Agents > Skills

**File:** `app.js` - `renderSkillsTable()` (Line ~9518)

**Changes:**
1. Wrap table in `.list-scroll-container` div
2. Add item count to toolbar
3. NO Load More needed (static registry)

### 7.3 Agents > Pipelines

**File:** `app.js` - `renderPipelinesView()` (Line ~10042)

**Changes:**
1. Change container class to use proper flex layout
2. Wrap table in `.list-scroll-container` div
3. Add item count to toolbar
4. NO Load More needed (VTID ledger is limited)

### 7.4 Agents > Telemetry

**File:** `app.js` - `renderTelemetryView()` (Line ~10350)

**Changes:**
1. Wrap table in `.list-scroll-container` div
2. Add item count to toolbar ("18 events")
3. ADD Load More button (API supports pagination)
4. Add pagination state management

### 7.5 Governance > Rules

**File:** `app.js` - `renderGovernanceRulesView()` (Line ~10783)

**Changes:**
1. Change `.governance-rules-container` to allow child scroll
2. Wrap table in `.list-scroll-container` div
3. Keep existing toolbar with count ("66 of 66 rules")
4. NO Load More needed (rules loaded from config)

### 7.6 Governance > Categories

**File:** `app.js` - `renderGovernanceCategoriesView()` (Line ~11940)

**Changes:**
1. Wrap category list in `.list-scroll-container`
2. Add item count
3. NO Load More needed (small set)

### 7.7 Governance > Evaluations

**File:** `app.js` - `renderGovernanceEvaluationsView()` (Line ~11256)

**Changes:**
1. Wrap table in `.list-scroll-container`
2. Add item count
3. ADD Load More if API supports pagination

### 7.8 Governance > Violations, Proposals, Controls

**Changes for each:**
1. Wrap content in `.list-scroll-container`
2. Add item count
3. Add Load More if data comes from database

---

## 8. Implementation Checklist

### Phase 1: CSS Fixes (Immediate)
- [ ] Fix `.agents-registry-container` overflow
- [ ] Fix `.governance-rules-container` overflow
- [ ] Verify `.list-scroll-container` class exists
- [ ] Verify `.load-more-container` class exists

### Phase 2: Agents Section
- [ ] Add scroll container to Registered Agents
- [ ] Add scroll container to Skills
- [ ] Add scroll container to Pipelines
- [ ] Add scroll container + Load More to Telemetry
- [ ] Add item counts to all toolbars

### Phase 3: Governance Section
- [ ] Add scroll container to Rules
- [ ] Add scroll container to Categories
- [ ] Add scroll container to Evaluations
- [ ] Add scroll container to Violations
- [ ] Add scroll container to Proposals
- [ ] Add scroll container to Controls
- [ ] Add Load More where needed

### Phase 4: Testing
- [ ] Verify all screens scroll properly
- [ ] Verify sticky headers work
- [ ] Verify Load More loads additional data
- [ ] Test with different viewport sizes

---

## 9. Files to Modify

| File | Changes |
|------|---------|
| `services/gateway/src/frontend/command-hub/app.js` | All render functions |
| `services/gateway/src/frontend/command-hub/styles.css` | Fix overflow on containers |

**NO BACKEND CHANGES REQUIRED**

---

## 10. Success Criteria

1. **ALL 10 screens scroll properly** - No content overflow
2. **Sticky headers work** - Column names visible while scrolling
3. **Item counts displayed** - Users see how many items loaded
4. **Load More works** - For screens with paginated data
5. **Consistent styling** - All screens use standard classes

---

## 11. Reference: OASIS Events (Working Example)

The OASIS Events screen is the reference implementation. Key elements:

**State with pagination:**
```javascript
oasisEvents: {
    items: [],
    pagination: { limit: 50, offset: 0, hasMore: true }
}
```

**Render with scroll container:**
```javascript
var content = document.createElement('div');
content.className = 'list-scroll-container oasis-events-content';
```

**Load More button:**
```javascript
if (state.oasisEvents.pagination.hasMore) {
    var loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'load-more-btn';
    loadMoreBtn.textContent = 'Load More';
    loadMoreBtn.onclick = loadMoreOasisEvents;
}
```

Use this pattern for all other screens.
