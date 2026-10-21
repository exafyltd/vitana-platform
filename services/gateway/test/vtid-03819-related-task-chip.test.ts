/**
 * VTID-03819: Related-task chip regression tests.
 *
 * app.js is a plain script with no module exports (Command Hub frontend),
 * so this is a source-text regression guard rather than an import-based
 * unit test — same pattern as vtid-03818-complete-completed-drift.test.ts.
 *
 * createRelatedTaskChip() reads task.metadata.related_vtid (set server-side
 * by createOperatorTask/ledger-task-dedup.ts when embedding search finds a
 * similar-but-not-duplicate task) and must be wired into both the task card
 * and the task drawer header.
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

describe('Related-task chip (VTID-03819)', () => {
  it('defines createRelatedTaskChip()', () => {
    expect(SOURCE).toMatch(/function createRelatedTaskChip\(task\)/);
  });

  it('createRelatedTaskChip reads task.metadata.related_vtid and returns null when absent', () => {
    const start = SOURCE.indexOf('function createRelatedTaskChip(task)');
    expect(start).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('\n}', start);
    const body = SOURCE.slice(start, end);
    expect(body).toContain('task.metadata && task.metadata.related_vtid');
    expect(body).toMatch(/if \(!relatedVtid\) return null;/);
  });

  it('the chip click filters the board via state.taskSearchQuery + renderApp()', () => {
    const start = SOURCE.indexOf('function createRelatedTaskChip(task)');
    const end = SOURCE.indexOf('\n}', start);
    const body = SOURCE.slice(start, end);
    expect(body).toContain('state.taskSearchQuery = relatedVtid');
    expect(body).toContain('renderApp();');
  });

  it('createTaskCard() appends the related chip after the stage timeline', () => {
    const idx = SOURCE.indexOf('const relatedChip = createRelatedTaskChip(task);');
    expect(idx).toBeGreaterThan(-1);
    const stageTimelineIdx = SOURCE.indexOf('card.appendChild(stageTimeline);');
    expect(stageTimelineIdx).toBeGreaterThan(-1);
    expect(idx).toBeGreaterThan(stageTimelineIdx);
  });

  it('renderTaskDrawer() appends the related chip to the drawer header', () => {
    const idx = SOURCE.indexOf('const drawerRelatedChip = createRelatedTaskChip(task);');
    expect(idx).toBeGreaterThan(-1);
    expect(SOURCE.slice(idx, idx + 200)).toContain('header.appendChild(drawerRelatedChip);');
  });

  it('styles.css defines the .task-related-chip class', () => {
    expect(CSS).toMatch(/\.task-related-chip\s*\{/);
  });
});
