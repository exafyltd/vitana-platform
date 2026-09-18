/**
 * VTID-04089 (T10, accessibility region 2 of 4): icon-only controls get an
 * `aria-label`, and standalone `<label>` elements are wired to their
 * control via `for=`.
 *
 * app.js is a plain browser script with no build step and no render-test
 * harness, so — matching this repo's established pattern for app.js (see
 * test/command-hub/t5c-no-fabricated-fallback-rows.test.ts) — this suite
 * pins the change by source text.
 *
 * Before this VTID, `aria-label` appeared 13 times against ~17 icon-only
 * close controls (`&times;`/unicode-glyph buttons) and 18 `<label>`
 * elements, only 6 of which used `for=`. One close button
 * (orb-chat-close) and 6 labels (Voice Lab) were already correct and are
 * untouched here.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');

describe('T10 region 2: every icon-only close control has an aria-label', () => {
  const appJs = readFileSync(APP_JS_PATH, 'utf8');

  it('every &times; close glyph has an aria-label within its own construction block', () => {
    const re = /&times;/g;
    let m: RegExpExecArray | null;
    const offenders: number[] = [];
    while ((m = re.exec(appJs))) {
      const windowSlice = appJs.slice(Math.max(0, m.index - 400), m.index + 100);
      if (!/aria-label/.test(windowSlice)) {
        offenders.push(appJs.slice(0, m.index).split('\n').length);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the ✕ (unicode) close button on the AI assistant drawer has an aria-label', () => {
    const idx = appJs.indexOf("closeBtn.textContent = '✕';");
    expect(idx).toBeGreaterThan(-1);
    const nearby = appJs.slice(idx, idx + 300);
    expect(nearby).toMatch(/setAttribute\(\s*['"]aria-label['"]/);
  });

  it('the attachment-remove chip glyph carries an aria-label naming the attachment', () => {
    expect(appJs).toContain(
      "chip.innerHTML = `${att.name} <span class=\"attachment-remove\" data-index=\"${index}\" aria-label=\"Remove attachment ${att.name}\">&times;</span>`;",
    );
  });
});

describe('T10 region 2: standalone <label> elements are wired to their control', () => {
  const appJs = readFileSync(APP_JS_PATH, 'utf8');

  it('every <label ...> not wrapping its control has a for= attribute', () => {
    // A label that WRAPS its input (e.g. `<label><input/> text</label>`) does
    // not need for=/id — that association is implicit and WCAG-compliant.
    // Only flag a bare `<label>` (no attributes at all) as a genuine miss;
    // this repo has exactly one legitimate wrapping-label site
    // (services/gateway/src/frontend/command-hub/app.js's live-probe
    // checkbox label), which this regex correctly leaves alone because it
    // already carries a style= attribute AND wraps an <input> — not a bare
    // `<label>`.
    const bareLabels = appJs.match(/<label>(?!.*<input)/g) || [];
    expect(bareLabels).toEqual([]);
  });

  it('the campaign-generation form wires all four labels to their inputs', () => {
    for (const id of ['vtid-03107-campaign', 'vtid-03107-count', 'vtid-03107-days', 'vtid-03107-plan']) {
      expect(appJs).toContain(`<label for="${id}"`);
      expect(appJs).toContain(`id="${id}"`);
    }
  });

  it('the marketplace-source input() factory labels each field by its generated id', () => {
    expect(appJs).toContain("'<label for=\"' + id + '\"");
  });

  it('the marketplace network <select> has an id and its label points at it', () => {
    expect(appJs).toContain("netSel.id = 'mp-network-select';");
    expect(appJs).toContain('<label for="mp-network-select"');
  });

  it('the AI assistant catalog/policy drawer labels each per-provider field by a unique id', () => {
    for (const idPrefix of [
      'ai-drawer-catalog-name-',
      'ai-drawer-catalog-enabled-',
      'ai-drawer-policy-allowed-',
      'ai-drawer-policy-models-',
      'ai-drawer-policy-costcap-',
    ]) {
      expect(appJs).toContain(`<label for="${idPrefix}' + provider + '">`);
      expect(appJs).toContain(`.id = '${idPrefix}' + provider;`);
    }
  });

  it('the pre-existing Voice Lab for= wiring is untouched', () => {
    for (const id of ['vl-orb-live-enabled', 'vl-experiment-id', 'vl-chunk-ms', 'vl-clear-interrupt', 'vl-debounce-ms', 'vl-model']) {
      expect(appJs).toContain(`<label for="${id}">`);
    }
  });
});
