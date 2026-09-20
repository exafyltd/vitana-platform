/**
 * VTID-04091 (T10, accessibility region 4 of 4): modal/drawer focus
 * management.
 *
 * app.js is a plain browser script with no build step and no render-test
 * harness, so — matching this repo's established pattern for app.js (see
 * test/command-hub/t5c-no-fabricated-fallback-rows.test.ts) — this suite
 * pins the change by source text.
 *
 * Before this VTID, every overlay/drawer/modal already closed on a
 * backdrop click and a close button, but none moved keyboard focus INTO
 * the dialog on open, trapped Tab inside it, or closed on Escape (WCAG
 * 2.4.3 Focus Order / 2.1.1 Keyboard). This VTID adds a shared
 * `attachModalA11y(panel, {onClose})` helper and wires it into 9 of the
 * overlay/drawer render functions — the ones confirmed to have no
 * background-polling re-render inside their own body that could fight the
 * new focus placement. `renderOperatorOverlay` (streaming chat) and
 * `renderTaskDrawer` (live execution-status polling) are deliberately
 * NOT converted this pass — flagged as a named follow-up, not silently
 * skipped.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');

describe('T10 region 4: attachModalA11y helper', () => {
  const appJs = readFileSync(APP_JS_PATH, 'utf8');

  it('is defined once, gives the panel tabIndex=-1, and handles Escape', () => {
    const idx = appJs.indexOf('function attachModalA11y(panel, opts) {');
    expect(idx).toBeGreaterThan(-1);
    const body = appJs.slice(idx, idx + 1500);
    expect(body).toContain('panel.tabIndex = -1;');
    expect(body).toContain("if (e.key === 'Escape') {");
    expect(body).toContain('if (opts.onClose) opts.onClose();');
  });

  it('defers initial focus placement (setTimeout) and checks panel.isConnected', () => {
    const idx = appJs.indexOf('function attachModalA11y(panel, opts) {');
    const body = appJs.slice(idx, idx + 1500);
    expect(body).toContain('setTimeout(function () {');
    expect(body).toContain('if (!panel.isConnected) return;');
  });

  it('only moves focus when nothing meaningful is already focused (never steals focus)', () => {
    const idx = appJs.indexOf('function attachModalA11y(panel, opts) {');
    const body = appJs.slice(idx, idx + 2000);
    expect(body).toContain("document.activeElement === document.body || document.activeElement == null");
  });

  it('uses preventScroll on every focus() call, to avoid fighting scroll-retained panels on a re-render', () => {
    const idx = appJs.indexOf('function attachModalA11y(panel, opts) {');
    const fnEnd = appJs.indexOf('\n}\n', idx);
    const body = appJs.slice(idx, fnEnd);
    const focusCalls = body.match(/\.focus\(([^)]*)\)/g) || [];
    expect(focusCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of focusCalls) {
      expect(call).toContain('preventScroll: true');
    }
  });

  it('implements a Tab-cycle trap between the first and last visible focusable descendant', () => {
    const idx = appJs.indexOf('function attachModalA11y(panel, opts) {');
    const body = appJs.slice(idx, idx + 2000);
    expect(body).toContain("if (e.key !== 'Tab') return;");
    expect(body).toContain('e.shiftKey && document.activeElement === first');
    expect(body).toContain('!e.shiftKey && document.activeElement === last');
  });

  it('is used at least 9 times (one per converted overlay/drawer)', () => {
    const callCount = (appJs.match(/\battachModalA11y\(/g) || []).length;
    expect(callCount).toBeGreaterThanOrEqual(9);
  });
});

describe('T10 region 4: converted overlays call attachModalA11y with the same close logic as their existing close button', () => {
  const appJs = readFileSync(APP_JS_PATH, 'utf8');

  it.each([
    ['renderHeartbeatOverlay', 'state.isHeartbeatOpen = false;'],
    ['renderPublishModal', 'state.showPublishModal = false;'],
    ['renderAutopilotRecommendationsModal', 'state.showAutopilotRecommendationsModal = false;'],
    ['renderGovernanceBlockedModal', 'state.showGovernanceBlockedModal = false;'],
    ['renderExecutionApprovalModal', 'state.showExecutionApprovalModal = false;'],
    ['renderGovernanceRuleDetailDrawer', 'state.selectedGovernanceRule = null;'],
    ['renderOasisEventDrawer', 'state.oasisEvents.selectedEvent = null;'],
    ['renderOasisVtidLedgerDrawer', 'oasisVtidDetail.selectedVtid = null;'],
  ])('%s wires attachModalA11y() with an onClose matching its state reset', (fnName, resetStatement) => {
    const fnIdx = appJs.indexOf(`function ${fnName}(`);
    expect(fnIdx).toBeGreaterThan(-1);
    const nextFnIdx = appJs.indexOf('\nfunction ', fnIdx + 1);
    const body = appJs.slice(fnIdx, nextFnIdx === -1 ? appJs.length : nextFnIdx);
    expect(body).toContain('attachModalA11y(');
    // The onClose block appears after the attachModalA11y( call and before
    // the function's own close — assert the reset statement appears
    // somewhere after the attachModalA11y call site (it's reused inline,
    // not factored into a shared closure, to keep this change additive).
    const attachIdx = body.indexOf('attachModalA11y(');
    expect(body.slice(attachIdx)).toContain(resetStatement);
  });

  it('openAiAssistantDrawer wires attachModalA11y() onto the panel, closing via root.remove()', () => {
    const fnIdx = appJs.indexOf('function openAiAssistantDrawer(provider) {');
    expect(fnIdx).toBeGreaterThan(-1);
    const nextFnIdx = appJs.indexOf('\nfunction ', fnIdx + 1);
    const body = appJs.slice(fnIdx, nextFnIdx === -1 ? appJs.length : nextFnIdx);
    expect(body).toContain('attachModalA11y(panel, {');
    const attachIdx = body.indexOf('attachModalA11y(panel, {');
    expect(body.slice(attachIdx, attachIdx + 200)).toContain('root.remove();');
  });
});

describe('T10 region 4: deliberately NOT converted this pass', () => {
  const appJs = readFileSync(APP_JS_PATH, 'utf8');

  it('renderOperatorOverlay (streaming chat) is untouched — no attachModalA11y call', () => {
    const fnIdx = appJs.indexOf('function renderOperatorOverlay(');
    expect(fnIdx).toBeGreaterThan(-1);
    const nextFnIdx = appJs.indexOf('\nfunction ', fnIdx + 1);
    const body = appJs.slice(fnIdx, nextFnIdx === -1 ? appJs.length : nextFnIdx);
    expect(body).not.toContain('attachModalA11y(');
  });

  it('renderTaskDrawer (live execution-status polling) is untouched — no attachModalA11y call', () => {
    const fnIdx = appJs.indexOf('function renderTaskDrawer(');
    expect(fnIdx).toBeGreaterThan(-1);
    const nextFnIdx = appJs.indexOf('\nfunction ', fnIdx + 1);
    const body = appJs.slice(fnIdx, nextFnIdx === -1 ? appJs.length : nextFnIdx);
    expect(body).not.toContain('attachModalA11y(');
  });
});
