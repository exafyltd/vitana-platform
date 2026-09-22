/**
 * VTID-04266: Autonomy Pulse surfaces awaiting_approval executions.
 *
 * Part of the Command Hub Autopilot supervisor-visibility task list named
 * in VTID-04262's CHANGE LOG row. Autonomy Pulse's own header comment
 * calls it "a single pane of glass so the supervisor never has to
 * correlate across [...] screens separately" — but `dev_autopilot_executions`
 * rows in `awaiting_approval` (VTID-04029: the agent pushed a branch and is
 * holding for a human decision) were excluded from BOTH the feed query and
 * the badge-count query. The one status that most needs a human's
 * attention was invisible to the exact screen built to surface it.
 *
 * The backend normalization/aggregation logic (aggregatePulse,
 * normalizeExecution, the SQL filter shape) is covered by
 * services/gateway/test/autonomy-pulse.test.ts. This file pins the
 * FRONTEND half: the Command Hub action dispatcher actually calling the
 * approve/reject routes for an autonomous_execution pulse item, matching
 * the exact routes the Autopilot Live / Dev Autopilot cards already use.
 *
 * Static source-check test, matching the established pattern for app.js
 * elsewhere in this suite (a plain IIFE bundle with no module export
 * surface).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../src/frontend/command-hub/app.js');
const INDEX_HTML_PATH = join(__dirname, '../src/frontend/command-hub/index.html');

describe('VTID-04266: Autonomy Pulse action dispatcher — approve/reject for autonomous_execution', () => {
  let src: string;

  beforeAll(() => {
    src = readFileSync(APP_JS_PATH, 'utf8');
  });

  it('an approve action on an autonomous_execution item calls the same route the Live/Dev Autopilot cards use', () => {
    const idx = src.indexOf("} else if (item.source === 'autonomous_execution') {");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 700);
    expect(block).toContain("action === 'approve'");
    expect(block).toContain("fetch('/api/v1/dev-autopilot/executions/' + execId + '/approve', { method: 'POST', headers, body: '{}' })");
  });

  it('a reject action on an autonomous_execution item calls the same route the Live/Dev Autopilot cards use', () => {
    const idx = src.indexOf("} else if (item.source === 'autonomous_execution') {");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 1000);
    expect(block).toContain("action === 'reject'");
    expect(block).toContain("fetch('/api/v1/dev-autopilot/executions/' + execId + '/reject', { method: 'POST', headers, body: '{}' })");
  });

  it('the existing cancel action for autonomous_execution is untouched', () => {
    const idx = src.indexOf("} else if (item.source === 'autonomous_execution') {");
    const block = src.slice(idx, idx + 1000);
    expect(block).toContain("fetch('/api/v1/dev-autopilot/executions/' + execId + '/cancel', { method: 'POST', headers, body: '{}' })");
  });

  it('the Command Hub cache-buster on index.html was bumped for this change', () => {
    const indexHtml = readFileSync(INDEX_HTML_PATH, 'utf8');
    const appVersion = (indexHtml.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(appVersion >= '20260922-vtid-04266-autonomy-pulse-approval').toBe(true);
    expect(indexHtml).toContain('styles.css?v=' + appVersion);
  });
});
