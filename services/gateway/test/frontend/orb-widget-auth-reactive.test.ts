import * as fs from 'fs';
import * as path from 'path';

// DEV-COMHU-0502 — ORB Recovery 1 (auth contract): static checks that the
// widget's setAuth is reactive (a real token lifts the anonymous lock) and
// that clearAuth wipes identity-bound continuity. Mirrors the static-analysis
// style of orb-widget-audio-playback.test.ts (widget runs in the browser; we
// assert on source so CI catches regressions to the auth contract).

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);

function extractObjectMethodBody(source: string, methodName: string): string {
  const sigIdx = source.indexOf(`${methodName}: function`);
  expect(sigIdx).toBeGreaterThanOrEqual(0);
  const openIdx = source.indexOf('{', sigIdx);
  expect(openIdx).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return source.slice(openIdx + 1, i);
  }
  throw new Error(`unclosed method body: ${methodName}`);
}

describe('orb-widget reactive auth contract (DEV-COMHU-0502)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('setAuth lifts the anonymous lock when a real token arrives', () => {
    const body = extractObjectMethodBody(source, 'setAuth');
    // A real token clears forceAnonymous (the old code hard-returned instead).
    expect(body).toMatch(/_cfg\.forceAnonymous = false/);
    expect(body).toMatch(/_cfg\.token = token/);
    // Empty/null routes to clearAuth (logout semantics).
    expect(body).toMatch(/if \(!token\)/);
    expect(body).toMatch(/VitanaOrb\.clearAuth\(\)/);
    // The anti-pattern (permanently ignoring setAuth) must be gone.
    expect(body).not.toMatch(/setAuth ignored/);
  });

  it('clearAuth wipes token AND identity-bound continuity (anti-leak)', () => {
    const body = extractObjectMethodBody(source, 'clearAuth');
    expect(body).toMatch(/_cfg\.token = ''/);
    expect(body).toMatch(/_s\._transcriptHistory = \[\]/);
    expect(body).toMatch(/_s\.conversationId = null/);
  });

  it('exposes clearAuth on the public API', () => {
    expect(source).toMatch(/clearAuth: function/);
  });
});
