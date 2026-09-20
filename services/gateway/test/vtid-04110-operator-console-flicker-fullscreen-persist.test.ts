/**
 * VTID-04110: reported live, furiously, with a screenshot of a long agentic
 * Operator Console turn — "you said you fixed the screen flickering with
 * every new turn. you also said you fixed that every turn is hidden behind
 * a dropdown instead of filling the screen unwanted." (An earlier claim of
 * a fix came from the Operator Console's own DeepSeek-powered agent inside
 * that chat — a different agent from the one that investigated and fixed
 * this, per the reply in that conversation.) Investigated the live code
 * directly rather than taking either party's word for it; both complaints
 * were real, distinct defects.
 *
 * Defect 1 — flicker on every new turn: `applyOperatorTurnFrame()` called
 * the full-app `renderApp()` (a root DOM teardown/rebuild of the ENTIRE
 * Command Hub — sidebar, header, the whole overlay) on every streamed SSE
 * frame: one `tool.call` + one `tool.result` per tool invocation, plus one
 * `model.turn` per model call. A multi-step agent run (the reported
 * screenshot shows a dozen-plus turns, several tool calls each) fires dozens
 * of these per run, each one visibly repainting the whole modal. Fixed with
 * `updateOperatorLiveTranscriptDom()`, which mutates only the one DOM node
 * that actually changed — the exact incremental-update pattern this file
 * already uses elsewhere for high-frequency updates (VTID-01151's
 * `updateApprovalsBadge()`).
 *
 * Defect 2 — the console never fills the screen: `state.isOperatorFullscreen`
 * (VTID-03905's fullscreen toggle) defaulted to `false` and was never
 * persisted, so every fresh page load reopened the console as a small,
 * fixed-size centered popup — exactly the "hidden behind a dropdown instead
 * of filling the screen" the user described, requiring a manual expand click
 * every single session to read a long, still-growing turn transcript
 * without scrolling inside a cramped box. Now persisted to localStorage
 * under `vitana.operatorFullscreen`, the same `vitana.<key>` convention
 * every other UI preference in this file already uses.
 *
 * app.js is a plain script (no export surface) — pinned by source text,
 * the same convention VTID-04106's/VTID-04033's suites use.
 */

import * as fs from 'fs';
import * as path from 'path';

const FE = path.resolve(__dirname, '../src/frontend/command-hub');
const APP_JS = fs.readFileSync(path.join(FE, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');
const GUARD_JS = fs.readFileSync(
  path.resolve(__dirname, '../../../scripts/ci/command-hub-ownership-guard.js'),
  'utf8',
);

function fnBody(name: string): string {
  const start = APP_JS.indexOf(`\nfunction ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = APP_JS.indexOf('\nfunction ', start + 1);
  return APP_JS.slice(start, next === -1 ? undefined : next);
}

describe('VTID-04110: Operator Console — no flicker on streamed turns, fullscreen persists', () => {
  describe('flicker fix', () => {
    it('applyOperatorTurnFrame() no longer calls the full-app renderApp() per frame', () => {
      const apply = fnBody('applyOperatorTurnFrame');
      expect(apply).not.toContain('renderApp();');
      expect(apply).toContain("frame.event === 'tool.call'");
      expect(apply).toContain("frame.event === 'tool.result'");
      expect(apply).toContain("frame.event === 'model.turn'");
      // All three frame kinds route through the same incremental updater.
      expect((apply.match(/updateOperatorLiveTranscriptDom\(\);/g) || []).length).toBe(3);
    });

    it('updateOperatorLiveTranscriptDom() mutates the live-transcript node in place instead of rebuilding the app', () => {
      const update = fnBody('updateOperatorLiveTranscriptDom');
      expect(update).toContain("document.querySelector('.chat-tool-activity--live')");
      expect(update).toContain('existing.replaceWith(renderOperatorLiveTranscript());');
    });

    it('falls back to a real renderApp() only when the live-transcript node is not mounted yet (the first frame of a turn)', () => {
      const update = fnBody('updateOperatorLiveTranscriptDom');
      const guardIdx = update.indexOf('if (!existing) {');
      const renderIdx = update.indexOf('renderApp();');
      const replaceIdx = update.indexOf('existing.replaceWith(');
      expect(guardIdx).toBeGreaterThan(-1);
      expect(renderIdx).toBeGreaterThan(guardIdx);
      expect(renderIdx).toBeLessThan(replaceIdx);
    });

    it('keeps the chat pinned to the bottom while streaming, respecting the user\'s own scroll position (VTID-04106)', () => {
      const update = fnBody('updateOperatorLiveTranscriptDom');
      expect(update).toContain("document.querySelector('.chat-messages')");
      expect(update).toContain('state.chatStickToBottom');
      expect(update).toContain('messagesEl.scrollTop = messagesEl.scrollHeight;');
    });
  });

  describe('fullscreen persistence', () => {
    it('isOperatorFullscreen is read from localStorage at state init instead of hardcoded false', () => {
      const idx = APP_JS.indexOf('isOperatorFullscreen: (function () {');
      expect(idx).toBeGreaterThan(-1);
      const block = APP_JS.slice(idx, APP_JS.indexOf('})(),', idx) + 6);
      expect(block).toContain("localStorage.getItem('vitana.operatorFullscreen') === 'true'");
      // Fails closed to the old default (small popup) if localStorage throws
      // (private browsing, blocked site data) rather than crashing state init.
      expect(block).toContain('} catch (e) { return false; }');
    });

    it('the fullscreen toggle button writes the choice back to localStorage', () => {
      const idx = APP_JS.indexOf('fullscreenBtn.onclick = () => {');
      expect(idx).toBeGreaterThan(-1);
      const block = APP_JS.slice(idx, APP_JS.indexOf('};', idx) + 2);
      expect(block).toContain('state.isOperatorFullscreen = !state.isOperatorFullscreen;');
      expect(block).toContain(
        "localStorage.setItem('vitana.operatorFullscreen', String(state.isOperatorFullscreen));",
      );
      // The set happens before the toggle takes visual effect.
      const setIdx = block.indexOf('localStorage.setItem');
      const renderIdx = block.indexOf('renderApp();');
      expect(setIdx).toBeGreaterThan(-1);
      expect(renderIdx).toBeGreaterThan(setIdx);
    });

    it('the write is wrapped in try/catch, same fail-safe convention as every other localStorage write in this file', () => {
      const idx = APP_JS.indexOf('fullscreenBtn.onclick = () => {');
      const block = APP_JS.slice(idx, APP_JS.indexOf('};', idx) + 2);
      expect(block).toMatch(/catch \(e\) \{ \/\* ignore \*\/ \}/);
    });
  });

  it('ships the cache-bust for both app.js and styles.css together, and the ownership-guard allowlist', () => {
    const ver = (INDEX_HTML.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(ver >= '20260919-vtid-04110-live-transcript-no-flicker').toBe(true);
    expect(INDEX_HTML).toContain('styles.css?v=' + ver);
    expect(GUARD_JS).toMatch(/ALLOWED_VTID_PATTERN = \/[^\n]*VTID-04110/);
  });
});
