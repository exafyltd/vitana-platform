/**
 * VTID-03852: LLM provider/model transparency badge on Command Hub
 * dev_autopilot_executions cards.
 *
 * app.js is a plain script with no module exports (Command Hub frontend), so
 * this is a source-text regression guard — same pattern as
 * vtid-03819-related-task-chip.test.ts. Both card renderers
 * (renderDevAutopilotExecutionCard for the Autopilot Developer panel, and
 * the inline card builder in the Autopilot Overview dashboard) render
 * dev_autopilot_executions rows independently and both need the badge —
 * a PostgREST `select=*` already returns each row's `metadata` column, so
 * this is UI-only work, no new API surface.
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

describe('LLM provider/model transparency badge (VTID-03852)', () => {
  it('renderDevAutopilotExecutionCard reads metadata.llm_on_ramp_override', () => {
    const start = SOURCE.indexOf('function renderDevAutopilotExecutionCard(exec)');
    expect(start).toBeGreaterThan(-1);
    const end = SOURCE.indexOf('\nfunction ', start + 1);
    const body = SOURCE.slice(start, end);
    expect(body).toContain('exec.metadata && exec.metadata.llm_on_ramp_override');
    expect(body).toContain("'llm: policy default (worker stage)'");
    expect(body).toMatch(/'llm: ' \+ onRampOverride\.provider/);
  });

  it('uses a CSS class rather than a scripted inline-style assignment (CSP governance gate surface)', () => {
    expect(SOURCE).toContain("llmBadge.className = 'llm-provider-badge';");
    expect(SOURCE).toContain("llmBadge2.className = 'llm-provider-badge';");
    expect(CSS).toContain('.llm-provider-badge {');
  });

  it('the Autopilot Overview dashboard card also renders the badge (second, independent renderer)', () => {
    const idx = SOURCE.indexOf('var llmOverride2 = exec.metadata && exec.metadata.llm_on_ramp_override;');
    expect(idx).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(idx, idx + 700);
    expect(nearby).toContain("'llm: policy default'");
  });

  it('the badge never hides the case where no override is set — always renders something', () => {
    // Both branches of the ternary must produce visible text, not '' or null,
    // so "no override" reads as informative ("policy default") rather than
    // as an empty/missing badge that looks like a rendering bug.
    const start = SOURCE.indexOf('function renderDevAutopilotExecutionCard(exec)');
    const end = SOURCE.indexOf('\nfunction ', start + 1);
    const body = SOURCE.slice(start, end);
    const match = body.match(/llmBadge\.textContent = \(onRampOverride[\s\S]*?\n\s*: 'llm: policy default \(worker stage\)';/);
    expect(match).not.toBeNull();
  });
});
