/**
 * VTID-04061: dead-code removal — the Dev Autopilot page's card renderer.
 *
 * app.js is a plain script with no module exports (Command Hub frontend), so
 * this is a source-text regression guard, matching this repo's established
 * pattern for app.js (see test/command-hub/memory-garden-placeholder-banner.test.ts).
 *
 * Verified before deletion (grep over the whole file):
 *   - `function renderDevAutopilotLiveTrace` had exactly one occurrence — its
 *     own definition. Zero call sites, so it could never render.
 *   - `function renderDevAutopilotExecutionCard` is only ever called from
 *     renderDevAutopilotLiveTrace, so it was unreachable too. The card rows
 *     operators actually see come from the Autopilot Overview dashboard's
 *     inline builder (`var llmOverride2 = ...`), which is untouched here.
 *   - A prose comment in that same dashboard block named
 *     renderDevAutopilotExecutionCard ("same transparency badge as
 *     renderDevAutopilotExecutionCard") and was rewritten rather than left
 *     dangling.
 *
 * This asserts the deletion stays deleted: no definition of either function
 * survives, and no comment references the removed name.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');
const INDEX_HTML_PATH = join(__dirname, '../../src/frontend/command-hub/index.html');

describe('Command Hub — dead Dev Autopilot card renderer removed (VTID-04061)', () => {
  let src: string;

  beforeAll(() => {
    src = readFileSync(APP_JS_PATH, 'utf8');
  });

  it('no longer defines renderDevAutopilotLiveTrace', () => {
    expect(src).not.toMatch(/function\s+renderDevAutopilotLiveTrace\b/);
  });

  it('no longer defines renderDevAutopilotExecutionCard', () => {
    expect(src).not.toMatch(/function\s+renderDevAutopilotExecutionCard\b/);
  });

  it('no comment references renderDevAutopilotExecutionCard by name', () => {
    expect(src).not.toContain('renderDevAutopilotExecutionCard');
  });

  it('the still-live Autopilot Overview badge builder is untouched', () => {
    // The removal must not have taken the reachable renderer with it.
    expect(src).toContain(
      'var llmOverride2 = exec.metadata && exec.metadata.llm_on_ramp_override;'
    );
    expect(src).toContain("llmBadge2.className = 'llm-provider-badge';");
  });

  it('bumps the cache-bust on both styles.css and app.js together', () => {
    const indexHtml = readFileSync(INDEX_HTML_PATH, 'utf8');
    const ver = (indexHtml.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(ver >= '20260918-vtid-04061-dead-code-removed').toBe(true);
    expect(indexHtml).toContain('styles.css?v=' + ver);
  });
});
