/**
 * Memory Garden (Command Hub) — placeholder-data visibility fix.
 *
 * GET /api/v1/memory/garden/progress falls into routes/memory.ts's
 * `_placeholder: true` branch on every call today (memory_get_garden_progress
 * does not exist in live Supabase, confirmed live via pg_proc 2026-08-29 —
 * see docs/AURORA-B3-DEAD-RPC-CALLSITE-AUDIT.md's addendum #3). The
 * Command Hub's fetchMemoryGardenProgress() merges that response into
 * state.memoryGarden.progress without checking `_placeholder`, and
 * previously rendered it identically to a genuinely empty Memory Garden —
 * "0 memories stored" across all 13 categories for every single user,
 * with zero visual indication the data is fake.
 *
 * This is structural/source-level, matching this repo's own established
 * pattern for app.js (a hand-maintained vanilla-JS single-page app with
 * no build step and no existing render-test harness — see
 * b0c-journey-context-panel.test.ts's identical approach). Asserts:
 *   1. renderMemoryGardenView checks `_placeholder` and renders a visible
 *      banner when present.
 *   2. The banner uses the existing `.admin-not-wired-banner` CSS class
 *      (already defined in styles.css, previously unused anywhere).
 *   3. The placeholder check does NOT early-return — the rest of the view
 *      (the all-zero category cards) still renders underneath the banner,
 *      exactly like the loading/error states are the only early-return
 *      branches.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');
const STYLES_CSS_PATH = join(__dirname, '../../src/frontend/command-hub/styles.css');

function readAppJs(): string {
  return readFileSync(APP_JS_PATH, 'utf8');
}

function readStylesCss(): string {
  return readFileSync(STYLES_CSS_PATH, 'utf8');
}

describe('Command Hub — Memory Garden placeholder-data banner', () => {
  let src: string;
  let css: string;

  beforeAll(() => {
    src = readAppJs();
    css = readStylesCss();
  });

  it('defines renderMemoryGardenView', () => {
    expect(src).toContain('function renderMemoryGardenView');
  });

  it('checks state.memoryGarden.progress?._placeholder and renders a visible banner', () => {
    expect(src).toContain('state.memoryGarden.progress?._placeholder');
    expect(src).toContain("placeholderBanner.className = 'admin-not-wired-banner'");
  });

  it('the placeholder-banner block sits between the error-state and main-content blocks, and does not early-return', () => {
    const fnMatch = src.match(/function renderMemoryGardenView\(\)\s*\{[\s\S]*?\n\}/);
    expect(fnMatch).toBeTruthy();
    const fnBody = fnMatch![0];

    const errorIdx = fnBody.indexOf("state.memoryGarden.error");
    const placeholderIdx = fnBody.indexOf('_placeholder');
    const mainContentIdx = fnBody.indexOf("mainContent.className = 'memory-garden-main'");

    expect(errorIdx).toBeGreaterThan(-1);
    expect(placeholderIdx).toBeGreaterThan(errorIdx);
    expect(mainContentIdx).toBeGreaterThan(placeholderIdx);

    // The placeholder branch must not contain a `return` — unlike the
    // loading/error branches immediately above it, which do.
    const placeholderBlockMatch = fnBody.match(
      /if \(state\.memoryGarden\.progress\?\._placeholder\) \{[\s\S]*?\n {4}\}/,
    );
    expect(placeholderBlockMatch).toBeTruthy();
    expect(placeholderBlockMatch![0]).not.toContain('return');
  });

  it('the .admin-not-wired-banner CSS class it reuses is actually defined', () => {
    expect(css).toContain('.admin-not-wired-banner');
  });
});
