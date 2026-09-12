/**
 * VTID-03823: Command Hub Tasks board hygiene UI — regression tests.
 *
 * app.js is a plain script with no module exports (Command Hub frontend),
 * so this is a source-text regression guard rather than an import-based
 * unit test — same pattern as vtid-03818/03819/03822's sibling test files.
 *
 * Four independent pieces, per this VTID's spec:
 *  (1) combinable filter chips (age / owner / source);
 *  (2) a staleness/age badge on every card;
 *  (3) Scheduled-only multi-select + bulk archive, reusing VTID-01052's
 *      existing DELETE /api/v1/oasis/tasks/:vtid semantics per task rather
 *      than the VTID-03818-fixed reaper path;
 *  (4) drag-and-drop from Scheduled into In Progress, reusing the existing
 *      Manual Start PATCH call and its spec-approval gate.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../src/frontend/command-hub/app.js'),
  'utf8'
);

const CSS = fs.readFileSync(
  path.join(__dirname, '../src/frontend/command-hub/styles.css'),
  'utf8'
);

describe('Age/staleness computation (VTID-03823)', () => {
  it('defines computeTaskAgeInfo() and treats >7 days + non-terminal as stale', () => {
    const start = SOURCE.indexOf('function computeTaskAgeInfo(task)');
    const end = SOURCE.indexOf('\n}', start);
    expect(start).toBeGreaterThan(-1);
    const body = SOURCE.slice(start, end);
    expect(body).toContain('var stale = days > 7 && !task.is_terminal;');
  });

  it('renders the age badge in the status row, only when a label exists', () => {
    const idx = SOURCE.indexOf('var ageInfo = computeTaskAgeInfo(task);');
    expect(idx).toBeGreaterThan(-1);
    const block = SOURCE.slice(idx, idx + 700);
    expect(block).toContain("if (ageInfo.label) {");
    expect(block).toContain("ageBadge.className = 'task-card-age-badge' + (ageInfo.stale ? ' task-card-age-badge-stale' : '');");
    expect(block).toContain('statusRow.appendChild(ageBadge);');
  });
});

describe('Source filter reuses the VTID-03516 session/autonomous distinction (VTID-03823)', () => {
  it('isAutonomousBoardTask() checks metadata.source/autonomous_execution, not a new rule', () => {
    const start = SOURCE.indexOf('function isAutonomousBoardTask(task)');
    const end = SOURCE.indexOf('\n}', start);
    expect(start).toBeGreaterThan(-1);
    const body = SOURCE.slice(start, end);
    expect(body).toContain("meta.source === 'self-healing' || meta.autonomous_execution === true");
  });
});

describe('Filter chips wired into the board filter chain (VTID-03823)', () => {
  it('age/owner/source filters are applied before a task is kept on the board', () => {
    const idx = SOURCE.indexOf('// VTID-03823: Age filter chip');
    expect(idx).toBeGreaterThan(-1);
    const block = SOURCE.slice(idx, idx + 900);
    expect(block).toContain("if (state.taskFilterAge === 'stale' && !ageInfo.stale) return false;");
    expect(block).toContain("if (state.taskFilterOwner === 'claimed' && !t.claimed_by) return false;");
    expect(block).toContain("if (state.taskFilterOwner === 'unclaimed' && t.claimed_by) return false;");
    expect(block).toContain('isAutonomousBoardTask(t)');
  });

  it('renderTasksView() renders a chip row with Age/Owner/Source groups', () => {
    const idx = SOURCE.indexOf("chipRow.className = 'task-filter-chip-row';");
    expect(idx).toBeGreaterThan(-1);
    const block = SOURCE.slice(idx, idx + 1600);
    expect(block).toContain("makeChipGroup('Age',");
    expect(block).toContain("makeChipGroup('Owner',");
    expect(block).toContain("makeChipGroup('Source',");
  });

  it('clicking the already-active chip clears that filter (toggle, not radio-lock)', () => {
    const idx = SOURCE.indexOf('function makeChipGroup(label, options, stateKey)');
    expect(idx).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('return group;', idx);
    const body = SOURCE.slice(idx, end);
    expect(body).toContain("state[stateKey] = (state[stateKey] === opt.value) ? '' : opt.value;");
  });
});

describe('Bulk-select + archive (VTID-03823)', () => {
  it('the select checkbox only renders for Scheduled-column cards', () => {
    const idx = SOURCE.indexOf("checkbox.className = 'task-card-select-checkbox';");
    expect(idx).toBeGreaterThan(-1);
    const before = SOURCE.slice(Math.max(0, idx - 400), idx);
    expect(before).toContain("if (columnStatus === 'Scheduled') {");
  });

  it('bulkArchiveSelectedTasks() confirms once and reuses the existing per-task DELETE endpoint, not a new bulk/reaper endpoint', () => {
    const start = SOURCE.indexOf('async function bulkArchiveSelectedTasks()');
    const end = SOURCE.indexOf('\nasync function handleTaskDropIntoInProgress', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = SOURCE.slice(start, end);
    expect(body).toContain('if (!confirm(confirmMsg)) return;');
    expect(body).toContain("fetch('/api/v1/oasis/tasks/' + vtid, {");
    expect(body).toContain("method: 'DELETE',");
    // No new "bulk" endpoint path — every request in this function hits the
    // exact same single-task URL VTID-01052's own delete button uses.
    expect(body).not.toMatch(/\/tasks\/bulk|\/bulk-archive|\/reaper/i);
  });

  it('the bulk-action bar only renders when at least one task is selected', () => {
    const idx = SOURCE.indexOf("bulkBar.className = 'task-bulk-action-bar';");
    expect(idx).toBeGreaterThan(-1);
    const before = SOURCE.slice(Math.max(0, idx - 300), idx);
    expect(before).toContain('if (state.taskMultiSelectIds.length > 0) {');
  });
});

describe('Drag-and-drop Scheduled -> In Progress (VTID-03823)', () => {
  it('cards are draggable only in the Scheduled column', () => {
    const idx = SOURCE.indexOf('card.draggable = true;');
    expect(idx).toBeGreaterThan(-1);
    const before = SOURCE.slice(Math.max(0, idx - 200), idx);
    expect(before).toContain("if (columnStatus === 'Scheduled') {");
  });

  it('only the "In Progress" column drop wires to a real mutation', () => {
    const idx = SOURCE.indexOf('content.ondrop = function (e) {');
    expect(idx).toBeGreaterThan(-1);
    const block = SOURCE.slice(idx, idx + 400);
    expect(block).toContain("if (colName === 'In Progress') {");
    expect(block).toContain('handleTaskDropIntoInProgress(droppedVtid);');
  });

  it('handleTaskDropIntoInProgress() enforces the same spec-approval gate as Manual Start, and reuses its exact PATCH call', () => {
    const start = SOURCE.indexOf('async function handleTaskDropIntoInProgress(vtid)');
    const end = SOURCE.indexOf('\nfunction renderTasksView()', start);
    expect(start).toBeGreaterThan(-1);
    const body = SOURCE.slice(start, end);
    expect(body).toContain("if (specStatus !== 'approved') {");
    expect(body).toContain("showToast('Cannot start: spec must be approved first', 'warning');");
    expect(body).toContain("method: 'PATCH',");
    expect(body).toContain("body: JSON.stringify({ status: 'in_progress' })");
  });
});

describe('CSS additions (VTID-03823)', () => {
  it('defines the filter chip, bulk-bar, drop-target, checkbox, and age-badge classes', () => {
    expect(CSS).toContain('.task-filter-chip-row {');
    expect(CSS).toContain('.task-filter-chip {');
    expect(CSS).toContain('.task-filter-chip-active {');
    expect(CSS).toContain('.task-bulk-action-bar {');
    expect(CSS).toContain('.column-content-drop-target {');
    expect(CSS).toContain('.task-card-select-checkbox {');
    expect(CSS).toContain('.task-card-age-badge {');
    expect(CSS).toContain('.task-card-age-badge-stale {');
  });
});

describe('Pre-existing zero-height status-row bug, fixed as part of shipping the age badge (VTID-03823)', () => {
  // Discovered while visually verifying the new age badge: `.task-card-status-row`
  // had `overflow: hidden`, which per the CSS Flexbox spec makes a flex item's
  // automatic minimum size resolve to 0 — inside the flex-column `.task-card`,
  // this row (and ONLY this row, since sibling rows lack `overflow: hidden`)
  // was measured at 0px real height on origin/main, before this VTID touched
  // the file, hiding the status pill and role badge already. Adding a third
  // item (the age badge) to the same collapsed row would have made that
  // pre-existing invisibility ship as-is; fixed at the root instead of
  // building on top of it.
  it('the status row no longer collapses to zero height (no overflow:hidden, flex-shrink:0)', () => {
    const idx = CSS.indexOf('.task-card-status-row {');
    expect(idx).toBeGreaterThan(-1);
    const lastIdx = CSS.lastIndexOf('.task-card-status-row {');
    const block = CSS.slice(lastIdx, CSS.indexOf('}', lastIdx));
    expect(block).toContain('flex-shrink: 0;');
    expect(block).not.toContain('overflow: hidden;');
  });

  it('the card height cap was raised enough to fit status-row + spec-row + stage-timeline without any of them shrinking', () => {
    const lastIdx = CSS.lastIndexOf('.task-card-enhanced {\n  min-height: 72px;');
    expect(lastIdx).toBeGreaterThan(-1);
    const block = CSS.slice(lastIdx, CSS.indexOf('}', lastIdx));
    expect(block).toContain('max-height: 148px;');
  });
});
