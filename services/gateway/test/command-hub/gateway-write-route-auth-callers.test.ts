/**
 * VTID-05697 (gateway-write-route-auth/route-auth): the Command Hub callers of the six gated write routes.
 *
 * The routes now need an exafy_admin JWT (or the service token). The Command Hub sends the Bearer token only
 * through buildContextHeaders() (app.js `function buildContextHeaders`), so every write call site of these routes
 * must build its headers with it. The caller census at the pin found exactly one write call site per route. Each
 * route is matched by its path and HTTP method (any quoting or concatenation of the path), so a new write caller
 * of the same route is counted too. x-actor-id / x-actor-role are no longer read by the gateway and must not be sent.
 */
import * as fs from 'fs';
import * as path from 'path';

const APP_JS = fs.readFileSync(path.resolve(__dirname, '../../src/frontend/command-hub/app.js'), 'utf8');

/** Every `fetch(<anchor>` call site, with its init object (up to the closing `})` of the call). */
function callSites(anchor: string): string[] {
  const out: string[] = [];
  let i = APP_JS.indexOf(anchor);
  while (i !== -1) {
    const end = APP_JS.indexOf('})', i);
    out.push(APP_JS.slice(i, end < 0 ? undefined : end + 2));
    i = APP_JS.indexOf(anchor, i + anchor.length);
  }
  return out;
}

const WRITE_CALLS: Array<{ route: string; anchor: string; method: string }> = [
  { route: 'PATCH /api/v1/specs/:vtid', anchor: "fetch('/api/v1/specs/' + encodeURIComponent(vtid), {", method: 'PATCH' },
  { route: 'POST /api/v1/agents/triage/investigate', anchor: "fetch('/api/v1/agents/triage/investigate', {", method: 'POST' },
  { route: 'PUT /api/v1/ai-personality/:surface_key', anchor: "fetch('/api/v1/ai-personality/' + surfaceKey, {", method: 'PUT' },
  { route: 'POST /api/v1/ai-personality/:surface_key/reset', anchor: "fetch('/api/v1/ai-personality/' + surfaceKey + '/reset', {", method: 'POST' },
  { route: 'POST /api/v1/llm/routing-policy', anchor: "fetch('/api/v1/llm/routing-policy?environment=DEV', {", method: 'POST' },
  { route: 'POST /api/v1/llm/routing-policy/reset', anchor: "fetch('/api/v1/llm/routing-policy/reset', {", method: 'POST' },
];

/** Every `fetch(` whose URL starts with `path` and whose init (up to the closing `})`) has `method: '<method>'`. */
function writeSites(pathRe: RegExp, method: string): string[] {
  const out: string[] = [];
  const re = new RegExp(String.raw`fetch\(\s*['"\`]` + pathRe.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(APP_JS)) !== null) {
    const end = APP_JS.indexOf('})', m.index);
    const site = APP_JS.slice(m.index, end < 0 ? undefined : end + 2);
    if (new RegExp(`method:\\s*['"]${method}['"]`).test(site)) out.push(site);
  }
  return out;
}

const ROUTE_PATHS: Array<{ route: string; path: RegExp; method: string; rest?: RegExp }> = [
  { route: 'PATCH /api/v1/specs/:vtid', path: /\/api\/v1\/specs\/['"\`]\s*\+\s*[\w.()]+\s*,/, method: 'PATCH' },
  { route: 'POST /api/v1/agents/triage/investigate', path: /\/api\/v1\/agents\/triage\/investigate['"\`?]/, method: 'POST' },
  { route: 'PUT /api/v1/ai-personality/:surface_key', path: /\/api\/v1\/ai-personality\//, method: 'PUT' },
  { route: 'POST /api/v1/ai-personality/:surface_key/reset', path: /\/api\/v1\/ai-personality\/['"\`]\s*\+\s*\w+\s*\+\s*['"\`]\/reset/, method: 'POST' },
  { route: 'POST /api/v1/llm/routing-policy', path: /\/api\/v1\/llm\/routing-policy['"\`?]/, method: 'POST' },
  { route: 'POST /api/v1/llm/routing-policy/reset', path: /\/api\/v1\/llm\/routing-policy\/reset/, method: 'POST' },
];

describe('VTID-05697 every write caller of the six routes, matched by path and method', () => {
  it.each(ROUTE_PATHS)('$route: one write call site in app.js, using buildContextHeaders', ({ path: p, method }) => {
    const sites = writeSites(p, method);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatch(/headers:\s*(Object\.assign\([^)]*)?buildContextHeaders\(/);
  });
});

describe('VTID-05697 Command Hub write callers send the Bearer helper', () => {
  it.each(WRITE_CALLS)('$route: exactly one write call site, and it uses buildContextHeaders', ({ anchor, method }) => {
    const sites = callSites(anchor).filter((s) => s.includes(`method: '${method}'`));
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatch(/headers:\s*(Object\.assign\([^)]*)?buildContextHeaders\(/);
  });

  it('the routing-policy write call sites carry no x-actor-* header', () => {
    for (const c of WRITE_CALLS.filter((w) => w.route.includes('routing-policy'))) {
      for (const s of callSites(c.anchor)) expect(s.toLowerCase()).not.toContain('x-actor-');
    }
  });

  it('app.js sends no x-actor-id / x-actor-role header anywhere', () => {
    expect(APP_JS.toLowerCase()).not.toContain("'x-actor-role'");
    expect(APP_JS.toLowerCase()).not.toContain("'x-actor-id'");
  });
});
