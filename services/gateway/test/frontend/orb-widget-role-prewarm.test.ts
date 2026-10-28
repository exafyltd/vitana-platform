/**
 * VTID-04548 (ORB latency F) — the widget warms the brain-cache key the NEXT
 * session start will use: its prewarm request carries the current route
 * (role follows the route) and the browser timezone (part of the key), and
 * the host can ask for a re-warm after a role switch via VitanaOrb.prewarm().
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '../../src/frontend/command-hub/orb-widget.js'), 'utf8');

function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf('\n  function ', start + 10);
  return src.slice(start, next);
}

describe('VTID-04548 widget role-aware prewarm', () => {
  it('_prewarmContext carries the route and the browser timezone, like the start payload', () => {
    const f = fnBody('_prewarmContext');
    expect(f).toContain('ctx.current_route = r');
    expect(f).toContain('Intl.DateTimeFormat().resolvedOptions().timeZone');
    expect(f).toContain('ctx.client_timezone = _tz');
    expect(f).toContain('_s.currentRoute');
  });

  it('the HTTP prewarm sends that context instead of an empty body', () => {
    const f = fnBody('_prewarmBootstrap');
    expect(f).toContain('body: JSON.stringify(_prewarmContext(route))');
    expect(f).not.toContain("body: '{}'");
    expect(f).toContain('if (!_cfg.token) return;');
  });

  it('the WS prewarm message carries the same context', () => {
    const f = fnBody('_prewarmNovaWs');
    expect(f).toContain('var _pwMsg = _prewarmContext();');
    expect(f).toContain("_pwMsg.type = 'prewarm';");
    expect(f).toContain('w.send(JSON.stringify(_pwMsg))');
  });

  it('VitanaOrb.prewarm(opts) is a best-effort HTTP cache warm only (no session, no Nova stream)', () => {
    const at = src.indexOf('    prewarm: function (opts) {');
    expect(at).toBeGreaterThan(src.indexOf('window.VitanaOrb = {'));
    const body = src.slice(at, src.indexOf('\n    },', at));
    expect(body).toContain('_prewarmBootstrap(route)');
    expect(body).not.toMatch(/_prewarmNovaWs|_sessionStart|_show\(/);
    expect(body).toContain('try {');
  });

  it('runs: prewarm posts route + timezone to the prewarm endpoint', () => {
    const calls: Array<{ url: string; init: any }> = [];
    const _s: any = { currentRoute: '/community' };
    const _cfg: any = { token: 't', gw: 'https://gw' };
    const fetchStub = (url: string, init: any) => { calls.push({ url, init }); return Promise.resolve({ ok: true }); };
    // eslint-disable-next-line no-new-func
    const make = new Function('_s', '_cfg', 'fetch', 'console',
      `${fnBody('_prewarmContext')}\n${fnBody('_prewarmBootstrap')}\nreturn _prewarmBootstrap;`);
    const prewarm = make(_s, _cfg, fetchStub, { log() {} });
    prewarm('/command-hub/overview');
    prewarm();
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://gw/api/v1/orb/live/session/prewarm');
    const b0 = JSON.parse(calls[0].init.body);
    const b1 = JSON.parse(calls[1].init.body);
    expect(b0.current_route).toBe('/command-hub/overview');
    expect(b1.current_route).toBe('/community');
    expect(typeof b0.client_timezone).toBe('string');
  });
});
