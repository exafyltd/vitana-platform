# VTID-01210: Live Ticker Formatting & UX Improvements

## Problem Statement

The Live Ticker in the Operator Console has two critical issues:

### Issue 1: Formatting Degradation After Initial Render
The ticker initially renders with proper formatting (green severity dots, timestamps, VTID badges in styled containers), but after 2-3 seconds switches to plain text formatting with no styling.

**Root Cause**: Two different rendering functions handle ticker items inconsistently:
- `renderOperatorTicker()` (lines 15814-16090) - Full render with proper styling, uses single character for stage badges
- `createTickerEventItem()` (lines 1735-1990) - Legacy incremental updates, uses full text for stage badges causing overflow in 20x20px fixed containers

### Issue 2: Information Overload
The ticker displays up to 50+ individual entries, overwhelming users with repetitive heartbeat/health check messages like:
```
8:49:31 AM Served 0 eligible tasks (worker_id=worker-runner-3447a044)
8:49:26 AM Served 0 eligible tasks (worker_id=worker-runner-3447a044)
8:49:21 AM Served 0 eligible tasks (worker_id=worker-runner-3447a044)
... (50+ more)
```

## Requirements

### R1: Consistent Formatting
The ticker must maintain consistent styling throughout its lifecycle, regardless of which update mechanism is triggered.

### R2: Summary-First Display (Lovable Solution)
Replace the verbose event list with a concise summary view showing:
- **Progress Counter**: "17 of 52 tasks completed"
- **Stage Progress**: Visual progress through P → W → V → D stages
- **Final Outcomes Only**: "VTID-01234 Completed" or "VTID-01234 Rejected"

### R3: Expandable Details (On-Demand)
Users can expand to see detailed logs only when needed, not by default.

### R4: Real-Time Updates Without Overload
Live updates should feel informative, not overwhelming.

---

## Technical Specification

### 1. Unified Rendering Function

**File**: `services/gateway/src/frontend/command-hub/app.js`

**Change**: Deprecate `createTickerEventItem()` and route all rendering through `renderOperatorTicker()`.

```javascript
// REMOVE or DEPRECATE the old function (lines 1735-1990)
// function createTickerEventItem(event) { ... }

// MODIFY updateTickerEventsList() to call full re-render
function updateTickerEventsList() {
  // Instead of incremental DOM manipulation:
  renderOperatorTicker(); // Full re-render with consistent styling
}
```

### 2. New Summary View Component

**Add new rendering mode**: Replace the flat event list with a summary dashboard.

#### 2.1 Summary State Structure

```javascript
// Add to state object (around line 2279)
tickerSummary: {
  totalTasks: 0,
  completedTasks: 0,
  rejectedTasks: 0,
  inProgressTasks: 0,
  currentStage: null,        // 'PLANNER' | 'WORKER' | 'VALIDATOR' | 'DEPLOY'
  vtidOutcomes: [],          // Array of { vtid, status: 'completed'|'rejected', timestamp }
  lastHeartbeat: null,       // Timestamp of last heartbeat
  heartbeatCount: 0,         // Count of collapsed heartbeats
},
tickerViewMode: 'summary',   // 'summary' | 'detailed'
```

#### 2.2 Summary View Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ STATUS: [LIVE]   TASKS: 17 of 52   CICD: OK                     │
├─────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────┐    │
│ │  P → W → V → D                                           │    │
│ │  ●   ●   ○   ○    Stage: VALIDATOR (3 remaining)         │    │
│ └──────────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────┤
│ OUTCOMES                                                        │
│ ✓ VTID-01202  Completed   8:49:31 AM                           │
│ ✓ VTID-01198  Completed   8:48:15 AM                           │
│ ✗ VTID-01195  Rejected    8:47:02 AM                           │
│                                                                 │
│ [Show 3 more outcomes...]                                       │
├─────────────────────────────────────────────────────────────────┤
│ ♡ 127 heartbeats (last: 8:49:31 AM)  [Expand Details ▼]        │
└─────────────────────────────────────────────────────────────────┘
```

#### 2.3 Summary View Implementation

```javascript
function renderTickerSummaryView(container) {
  const summary = state.tickerSummary;

  // Progress section
  const progressSection = document.createElement('div');
  progressSection.className = 'ticker-progress-section';
  progressSection.innerHTML = `
    <div class="ticker-progress-counter">
      <span class="ticker-progress-number">${summary.completedTasks}</span>
      <span class="ticker-progress-of">of</span>
      <span class="ticker-progress-total">${summary.totalTasks}</span>
      <span class="ticker-progress-label">tasks completed</span>
    </div>
    <div class="ticker-stage-pipeline">
      ${renderStagePipeline(summary.currentStage)}
    </div>
  `;

  // Outcomes section (final results only)
  const outcomesSection = document.createElement('div');
  outcomesSection.className = 'ticker-outcomes-section';

  const recentOutcomes = summary.vtidOutcomes.slice(0, 5); // Show last 5
  recentOutcomes.forEach(outcome => {
    const item = document.createElement('div');
    item.className = `ticker-outcome-item ticker-outcome-${outcome.status}`;
    item.innerHTML = `
      <span class="ticker-outcome-icon">${outcome.status === 'completed' ? '✓' : '✗'}</span>
      <span class="ticker-outcome-vtid">${outcome.vtid}</span>
      <span class="ticker-outcome-status">${capitalize(outcome.status)}</span>
      <span class="ticker-outcome-time">${outcome.timestamp}</span>
    `;
    outcomesSection.appendChild(item);
  });

  // Collapsed heartbeat indicator
  const heartbeatIndicator = document.createElement('div');
  heartbeatIndicator.className = 'ticker-heartbeat-indicator';
  heartbeatIndicator.innerHTML = `
    <span class="heartbeat-icon">♡</span>
    <span class="heartbeat-count">${summary.heartbeatCount} heartbeats</span>
    <span class="heartbeat-last">(last: ${summary.lastHeartbeat || 'N/A'})</span>
    <button class="ticker-expand-btn" onclick="toggleTickerDetailView()">
      Expand Details ▼
    </button>
  `;

  container.appendChild(progressSection);
  container.appendChild(outcomesSection);
  container.appendChild(heartbeatIndicator);
}

function renderStagePipeline(currentStage) {
  const stages = ['PLANNER', 'WORKER', 'VALIDATOR', 'DEPLOY'];
  const currentIdx = stages.indexOf(currentStage);

  return stages.map((stage, idx) => {
    const status = idx < currentIdx ? 'completed' :
                   idx === currentIdx ? 'active' : 'pending';
    return `
      <div class="pipeline-stage pipeline-stage-${status}">
        <span class="pipeline-dot"></span>
        <span class="pipeline-label">${stage.charAt(0)}</span>
      </div>
      ${idx < stages.length - 1 ? '<span class="pipeline-arrow">→</span>' : ''}
    `;
  }).join('');
}
```

### 3. Event Aggregation Logic

**Transform raw events into summary data**:

```javascript
function aggregateTickerEvents(events) {
  const summary = {
    totalTasks: 0,
    completedTasks: 0,
    rejectedTasks: 0,
    inProgressTasks: 0,
    currentStage: null,
    vtidOutcomes: [],
    lastHeartbeat: null,
    heartbeatCount: 0,
  };

  const vtidMap = new Map(); // Track unique VTIDs

  events.forEach(event => {
    // Count heartbeats
    if (isHeartbeatEvent(event)) {
      summary.heartbeatCount++;
      summary.lastHeartbeat = event.timestamp;
      return;
    }

    // Track VTID outcomes
    if (event.vtid) {
      const existing = vtidMap.get(event.vtid);

      if (event.topic?.includes('success') || event.content?.includes('Completed')) {
        vtidMap.set(event.vtid, {
          vtid: event.vtid,
          status: 'completed',
          timestamp: event.timestamp
        });
        summary.completedTasks++;
      } else if (event.topic?.includes('failed') || event.content?.includes('Rejected')) {
        vtidMap.set(event.vtid, {
          vtid: event.vtid,
          status: 'rejected',
          timestamp: event.timestamp
        });
        summary.rejectedTasks++;
      } else if (!existing) {
        summary.inProgressTasks++;
      }
    }

    // Track current stage
    if (event.task_stage) {
      summary.currentStage = event.task_stage;
    }
  });

  summary.vtidOutcomes = Array.from(vtidMap.values())
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  summary.totalTasks = summary.completedTasks + summary.rejectedTasks + summary.inProgressTasks;

  return summary;
}

function isHeartbeatEvent(event) {
  return event.type === 'heartbeat' ||
         event.type === 'ping' ||
         event.content?.includes('heartbeat') ||
         event.content?.includes('health') ||
         event.content?.includes('Served 0 eligible tasks');
}
```

### 4. CSS Updates

**File**: `services/gateway/src/frontend/command-hub/styles.css`

```css
/* Summary View Styles */
.ticker-progress-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 1rem;
  background: var(--color-surface);
  border-radius: 8px;
  margin: 0.5rem;
}

.ticker-progress-counter {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.ticker-progress-number {
  color: var(--color-success);
  font-size: 2rem;
}

.ticker-progress-of,
.ticker-progress-label {
  color: var(--color-text-secondary);
  margin: 0 0.25rem;
}

.ticker-stage-pipeline {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 1rem;
}

.pipeline-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
}

.pipeline-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--color-border);
}

.pipeline-stage-completed .pipeline-dot {
  background: var(--color-success);
  border-color: var(--color-success);
}

.pipeline-stage-active .pipeline-dot {
  background: var(--color-warning);
  border-color: var(--color-warning);
  animation: pulse 1.5s infinite;
}

.pipeline-stage-pending .pipeline-dot {
  background: transparent;
}

.pipeline-arrow {
  color: var(--color-text-secondary);
  font-size: 1.2rem;
}

/* Outcomes Section */
.ticker-outcomes-section {
  padding: 0.5rem;
}

.ticker-outcome-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  margin-bottom: 0.25rem;
}

.ticker-outcome-completed {
  background: rgba(34, 197, 94, 0.1);
}

.ticker-outcome-rejected {
  background: rgba(239, 68, 68, 0.1);
}

.ticker-outcome-icon {
  font-size: 1rem;
}

.ticker-outcome-completed .ticker-outcome-icon {
  color: var(--color-success);
}

.ticker-outcome-rejected .ticker-outcome-icon {
  color: var(--color-error);
}

.ticker-outcome-vtid {
  font-family: monospace;
  font-weight: 600;
  color: var(--color-primary);
}

.ticker-outcome-status {
  flex: 1;
  color: var(--color-text-secondary);
}

.ticker-outcome-time {
  font-size: 0.8rem;
  color: var(--color-text-tertiary);
}

/* Heartbeat Indicator */
.ticker-heartbeat-indicator {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: var(--color-surface-alt);
  border-top: 1px solid var(--color-border);
  font-size: 0.85rem;
  color: var(--color-text-secondary);
}

.heartbeat-icon {
  color: var(--color-success);
  animation: heartbeat 2s infinite;
}

@keyframes heartbeat {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.1); }
}

.ticker-expand-btn {
  margin-left: auto;
  padding: 0.25rem 0.5rem;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}

.ticker-expand-btn:hover {
  background: var(--color-surface);
  border-color: var(--color-primary);
}

/* View Mode Toggle */
.ticker-view-toggle {
  display: flex;
  gap: 0.25rem;
  padding: 0.25rem;
  background: var(--color-surface-alt);
  border-radius: 6px;
}

.ticker-view-btn {
  padding: 0.25rem 0.5rem;
  border: none;
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.75rem;
}

.ticker-view-btn.active {
  background: var(--color-primary);
  color: white;
}
```

### 5. View Toggle Implementation

Add a toggle between Summary and Detailed views:

```javascript
function renderTickerViewToggle() {
  const toggle = document.createElement('div');
  toggle.className = 'ticker-view-toggle';
  toggle.innerHTML = `
    <button class="ticker-view-btn ${state.tickerViewMode === 'summary' ? 'active' : ''}"
            onclick="setTickerViewMode('summary')">
      Summary
    </button>
    <button class="ticker-view-btn ${state.tickerViewMode === 'detailed' ? 'active' : ''}"
            onclick="setTickerViewMode('detailed')">
      Detailed
    </button>
  `;
  return toggle;
}

function setTickerViewMode(mode) {
  state.tickerViewMode = mode;
  renderOperatorTicker();
}

function toggleTickerDetailView() {
  setTickerViewMode(state.tickerViewMode === 'summary' ? 'detailed' : 'summary');
}
```

---

## Implementation Checklist

- [ ] **Phase 1: Fix Formatting Bug**
  - [ ] Update `createTickerEventItem()` to use single character for stage badges
  - [ ] OR deprecate `createTickerEventItem()` and use full re-render
  - [ ] Test that formatting persists after SSE updates

- [ ] **Phase 2: Add Summary View**
  - [ ] Add `tickerSummary` and `tickerViewMode` to state
  - [ ] Implement `aggregateTickerEvents()` function
  - [ ] Implement `renderTickerSummaryView()` function
  - [ ] Add CSS for summary view components

- [ ] **Phase 3: Add View Toggle**
  - [ ] Add toggle buttons to ticker toolbar
  - [ ] Implement `setTickerViewMode()` function
  - [ ] Default to 'summary' view mode

- [ ] **Phase 4: Polish & Testing**
  - [ ] Test with high-volume event streams
  - [ ] Verify heartbeat collapsing works correctly
  - [ ] Test stage pipeline animation
  - [ ] Ensure real-time updates feel smooth

---

## Acceptance Criteria

1. **AC1**: Ticker formatting remains consistent from initial load through all subsequent updates
2. **AC2**: Default view shows summary with "X of Y tasks completed" counter
3. **AC3**: Only final outcomes (Completed/Rejected) display by default, not intermediate events
4. **AC4**: Heartbeat events are collapsed into a single indicator showing count and last timestamp
5. **AC5**: Users can expand to detailed view on demand
6. **AC6**: Stage pipeline (P → W → V → D) shows visual progress through deployment stages
7. **AC7**: Real-time updates feel informative without overwhelming the user

---

## Files to Modify

| File | Changes |
|------|---------|
| `services/gateway/src/frontend/command-hub/app.js` | Add summary rendering, fix badge rendering, add view toggle |
| `services/gateway/src/frontend/command-hub/styles.css` | Add summary view styles, pipeline animations |

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Full re-render may cause flicker | Use virtual DOM diffing or batch updates |
| Summary aggregation may miss edge cases | Add comprehensive unit tests for event classification |
| View toggle may confuse users | Default to summary, add clear toggle UI |

---

## Related Issues

- Caused by: Inconsistent rendering between `renderOperatorTicker()` and `createTickerEventItem()`
- Related: VTID-01209 (Real-time Task Execution Status tracking)
