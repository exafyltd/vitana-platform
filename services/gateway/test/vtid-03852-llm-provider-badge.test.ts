/**
 * VTID-03852: LLM provider/model transparency badge on Command Hub
 * dev_autopilot_executions cards.
 *
 * app.js is a plain script with no module exports (Command Hub frontend), so
 * this is a source-text regression guard — same pattern as
 * vtid-03819-related-task-chip.test.ts.
 *
 * VTID-04061: the Dev Autopilot page's own card renderer
 * (renderDevAutopilotExecutionCard, only ever reached from the equally
 * uncalled renderDevAutopilotLiveTrace) was dead code and has been deleted.
 * The card operators actually see is the inline builder in the Autopilot
 * Overview dashboard (`var llmOverride2 = ...`), which is now the sole
 * renderer of dev_autopilot_executions rows — these assertions were folded
 * into it. A PostgREST `select=*` already returns each row's `metadata`
 * column, so this is UI-only work, no new API surface.
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

/** Slice from the dashboard's override read to the end of its badge block. */
function badgeBlock(): string {
  const start = SOURCE.indexOf(
    'var llmOverride2 = exec.metadata && exec.metadata.llm_on_ramp_override;'
  );
  expect(start).toBeGreaterThan(-1);
  return SOURCE.slice(start, start + 700);
}

describe('LLM provider/model transparency badge (VTID-03852)', () => {
  it('the executions card reads metadata.llm_on_ramp_override', () => {
    const body = badgeBlock();
    expect(body).toContain('exec.metadata && exec.metadata.llm_on_ramp_override');
    expect(body).toContain("'llm: policy default'");
    expect(body).toMatch(/'llm: ' \+ llmOverride2\.provider/);
  });

  it('uses a CSS class rather than a scripted inline-style assignment (CSP governance gate surface)', () => {
    expect(SOURCE).toContain("llmBadge2.className = 'llm-provider-badge';");
    expect(CSS).toContain('.llm-provider-badge {');
  });

  it('the badge never hides the case where no override is set — always renders something', () => {
    // Both branches of the ternary must produce visible text, not '' or null,
    // so "no override" reads as informative ("policy default") rather than
    // as an empty/missing badge that looks like a rendering bug.
    const match = badgeBlock().match(
      /llmBadge2\.textContent = \(llmOverride2[\s\S]*?\n\s*: 'llm: policy default';/
    );
    expect(match).not.toBeNull();
  });
});
