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

function extractFunctionBody(source: string, signature: string): string {
  const sigIdx = source.indexOf(signature);
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
  throw new Error(`unclosed function body: ${signature}`);
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

  it('clearAuth stops the live session, clears token, and wipes identity-bound continuity (anti-leak)', () => {
    const body = extractObjectMethodBody(source, 'clearAuth');
    // Must tear down the old-identity live session BEFORE dropping the token.
    expect(body).toMatch(/_sessionStop\(\)/);
    expect(body).toMatch(/_cfg\.token = ''/);
    expect(body).toMatch(/_wipeIdentityBoundState\(\)/);
    // session-stop must precede the token clear so the stop authenticates as
    // the departing identity.
    expect(body.indexOf('_sessionStop()')).toBeLessThan(body.indexOf("_cfg.token = ''"));
  });

  it('_wipeIdentityBoundState clears all identity-bound continuity fields', () => {
    const body = extractFunctionBody(source, 'function _wipeIdentityBoundState()');
    expect(body).toMatch(/_s\._transcriptHistory = \[\]/);
    expect(body).toMatch(/_s\.conversationId = null/);
    expect(body).toMatch(/_s\._preDisconnectStage = null/);
    expect(body).toMatch(/_s\._reconnectCount = 0/);
  });

  it('setAuth wipes continuity + stops the session ONLY on account switch (sub change)', () => {
    const body = extractObjectMethodBody(source, 'setAuth');
    // Detects identity change via JWT sub, and only then resets.
    expect(body).toMatch(/_jwtSub\(token\)/);
    expect(body).toMatch(/identityChanged/);
    expect(body).toMatch(/_wipeIdentityBoundState\(\)/);
    expect(body).toMatch(/_sessionStop\(\)/);
  });

  it('_jwtSub extracts the JWT subject for account-switch detection', () => {
    const body = extractFunctionBody(source, 'function _jwtSub(token)');
    expect(body).toMatch(/payload\.sub/);
  });

  it('init seeds the identity baseline so a same-user refresh is not a switch', () => {
    expect(source).toMatch(/_lastAuthSub = _jwtSub\(_cfg\.token\)/);
  });

  it('exposes clearAuth on the public API', () => {
    expect(source).toMatch(/clearAuth: function/);
  });
});
