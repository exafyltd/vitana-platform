/**
 * VTID-04520 / VTID-04521 — the widget plays a registry navigation out after
 * the reply, and tells the gateway what the app did.
 *
 * The widget is a plain IIFE with no export surface, so — like the other
 * orb-widget suites — these are static source checks.
 */
import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(path.resolve(__dirname, '../../src/frontend/command-hub/orb-widget.js'), 'utf8');

function fnBody(name: string): string {
  const i = source.indexOf(`function ${name}(`);
  expect(i).toBeGreaterThan(-1);
  let depth = 0;
  for (let j = source.indexOf('{', i); j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}' && --depth === 0) return source.slice(i, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe('speak-then-navigate', () => {
  it('holds an after_speech directive instead of navigating mid-sentence', () => {
    const i = source.indexOf("msg.directive === 'navigate' && msg.after_speech === true");
    const legacy = source.indexOf("if (msg.directive === 'navigate') {");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(legacy); // checked before the legacy handler
    const branch = source.slice(i, legacy);
    expect(branch).toMatch(/_s\.pendingNavDirective = msg/);
    expect(branch).toMatch(/15000/); // a turn that never completes still navigates
    expect(branch).toMatch(/break;/);
  });

  it('runs the held directive when the turn completes', () => {
    const i = source.indexOf("case 'turn_complete':");
    const slice = source.slice(i, i + 800);
    expect(slice).toMatch(/if \(_s\.pendingNavDirective\)/);
    expect(slice).toMatch(/_runNavDirective\(_pendingNav, _s\._sessionGeneration\)/);
  });

  it('clears a held directive at every session start', () => {
    expect(source).toMatch(/_s\.pendingNavDirective = null; \/\/ VTID-04521/);
  });

  it('waits for the audio to drain, keeps the orb for overlays, closes it for screens', () => {
    const body = fnBody('_runNavDirective');
    expect(body).toMatch(/keep_orb_open === true \|\| msg\.entry_kind === 'overlay'/);
    expect(body).toMatch(/if \(!stays\) _s\.navigationPending = true/);
    expect(body).toMatch(/scheduledSources/);
    expect(body).toMatch(/_cfg\.onNavigationRequest\(msg\.route, ctx\)/);
    expect(body).toMatch(/if \(!stays && _s\._sessionGeneration === myGen\) _hide\(\)/);
    expect(body).toMatch(/typeof result\.then === 'function'/);
  });

  it('reports the outcome before the session closes, over WS or /stream/send', () => {
    const body = fnBody('_sendNavResult');
    expect(body).toMatch(/type: 'nav_result'/);
    expect(body).toMatch(/target\.ws\.send\(body\)/);
    expect(body).toMatch(/\/api\/v1\/orb\/live\/stream\/send\?session_id=/);
    expect(body).toMatch(/keepalive: true/);
    // captured before _hide() clears the session
    expect(fnBody('_runNavDirective')).toMatch(/var target = \{ sessionId: _s\.sessionId, ws: _s\.ws \}/);
  });

  it('sends the host-reported viewport at session start', () => {
    expect(source).toMatch(/startPayload\.is_mobile = _s\.isMobileHost/);
    expect(source).toMatch(/_s\.isMobileHost = opts\.initialContext\.is_mobile/);
  });
});
