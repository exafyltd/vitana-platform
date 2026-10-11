/**
 * VTID-05063 — every Command Hub read of a Tier 1 ledger route sends the
 * operator's bearer, so `LEDGER_READ_AUTH_MODE=enforce` cannot turn a missed
 * call site into a 401 (and, through the fetch interceptor, a refresh-token
 * burn or a logout loop).
 *
 * The scan does not trust "the line contains fetch(": it finds every
 * `fetch(` token, walks to its balanced closing paren (quotes, template
 * literals and nested parens tracked), takes the first argument as the URL
 * expression, and requires `buildContextHeaders` inside that call expression
 * (or, for the standalone debug page, the bearer read from
 * localStorage['vitana.authToken']). The fixture cases below prove it catches
 * a call split across lines, a call inside Promise.all([...]) and a
 * `.then(...)`-chained call.
 */

import * as fs from 'fs';
import * as path from 'path';

const HUB = path.join(__dirname, '../src/frontend/command-hub');
const APP = fs.readFileSync(path.join(HUB, 'app.js'), 'utf8');
const DEBUG = fs.readFileSync(path.join(HUB, 'debug.html'), 'utf8');

/** Tier 1 read prefixes (plan section 1). Health stays open. */
const TIER1: RegExp[] = [
  /\/api\/v1\/vtid\/(?!health)/,
  /\/api\/v1\/commandhub\/board/,
  /\/api\/v1\/board\b/,
  /\/api\/v1\/tasks\b/,
  /\/api\/v1\/approvals\/(pending|count)/,
  /\/api\/v1\/oasis\/tasks/,
  /\/api\/v1\/oasis\/vtid-ledger/,
];
/** Writes are VTID-04727's gate (and already send the header); this test is about reads. */
const WRITE_METHOD = /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i;

function skipString(src: string, i: number, quote: string): number {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === quote || src[j] === '\n') return j;
  }
  return src.length;
}

function skipTemplate(src: string, i: number): number {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '`') return j;
    if (src[j] === '$' && src[j + 1] === '{') {
      let depth = 0;
      for (let k = j + 1; k < src.length; k++) {
        const c = src[k];
        if (c === "'" || c === '"') { k = skipString(src, k, c); continue; }
        if (c === '`') { k = skipTemplate(src, k); continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { j = k; break; } }
      }
    }
  }
  return src.length;
}

/**
 * Walks from the `(` at `open` to its matching `)`. Returns the index of the
 * closing paren and the index of the first top-level comma (end of argument 1).
 */
function matchCall(src: string, open: number): { close: number; firstArgEnd: number } | null {
  let depth = 0;
  let firstArgEnd = -1;
  for (let i = open; i < src.length && i < open + 20_000; i++) {
    const c = src[i];
    if (c === "'" || c === '"') { i = skipString(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) return null; i = nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); if (end < 0) return null; i = end + 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        if (c !== ')') return null;
        return { close: i, firstArgEnd: firstArgEnd < 0 ? i : firstArgEnd };
      }
    } else if (c === ',' && depth === 1 && firstArgEnd < 0) firstArgEnd = i;
  }
  return null;
}

interface FetchCall { line: number; url: string; call: string }

function scanFetchCalls(src: string): FetchCall[] {
  const out: FetchCall[] = [];
  const re = /\bfetch\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const before = src.slice(lineStart, m.index).trim();
    if (before.startsWith('//') || before.startsWith('*') || before.startsWith('/*')) continue;
    const line = src.slice(0, m.index).split('\n').length;
    const open = m.index + m[0].length - 1;
    const match = matchCall(src, open);
    if (!match) {
      // Unparseable: judge the next 300 chars conservatively.
      const window = src.slice(m.index, m.index + 300);
      out.push({ line, url: window, call: window });
      continue;
    }
    out.push({ line, url: src.slice(open + 1, match.firstArgEnd), call: src.slice(m.index, match.close + 1) });
  }
  return out;
}

function tier1Reads(src: string): FetchCall[] {
  return scanFetchCalls(src)
    .filter((c) => !WRITE_METHOD.test(c.call))
    .filter((c) => TIER1.some((re) => re.test(c.url)));
}

function violations(src: string, opts: { storedBearer?: boolean } = {}): string[] {
  return tier1Reads(src)
    .filter((c) => !c.call.includes('buildContextHeaders('))
    .filter((c) => !(opts.storedBearer && /Authorization:\s*'Bearer '\s*\+\s*token/.test(c.call)))
    .map((c) => `line ${c.line}: ${c.call.slice(0, 160).replace(/\s+/g, ' ')}`);
}

describe('VTID-05063 scanner fixtures', () => {
  it('catches a call split across lines', () => {
    const src = "async function a() {\n  var r = await fetch(\n    '/api/v1/tasks?limit=1',\n    { method: 'GET' }\n  );\n}\n";
    expect(violations(src)).toHaveLength(1);
  });

  it('checks each call inside Promise.all([...]) on its own', () => {
    const ok = "Promise.all([\n  fetch('/api/v1/vtid/' + encodeURIComponent(v), { headers: buildContextHeaders() }),\n  fetch('/api/v1/events?vtid=' + encodeURIComponent(v) + '&limit=100')\n]);\n";
    expect(violations(ok)).toEqual([]);
    const bad = "Promise.all([\n  fetch('/api/v1/vtid/' + encodeURIComponent(v)),\n  fetch('/api/v1/events?vtid=' + v, { headers: buildContextHeaders() })\n]);\n";
    expect(violations(bad)).toHaveLength(1);
  });

  it('does not credit headers that only appear in a chained .then(...)', () => {
    const bad = "fetch('/api/v1/approvals/pending?limit=5').then(function (r) { buildContextHeaders(); return r.json(); });\n";
    expect(violations(bad)).toHaveLength(1);
    const ok = "fetch('/api/v1/approvals/pending?limit=5', { headers: buildContextHeaders() }).then(function (r) { return r.json(); });\n";
    expect(violations(ok)).toEqual([]);
  });

  it('catches a template-literal URL', () => {
    expect(violations('fetch(`/api/v1/vtid/${encodeURIComponent(v)}/execution-status`);\n')).toHaveLength(1);
  });

  it('leaves health probes, Tier 2 reads, comments and writes alone', () => {
    const src = [
      "fetch('/api/v1/vtid/health');",
      "fetch('/api/v1/events?limit=3');",
      "// fetch('/api/v1/tasks')",
      "fetch('/api/v1/oasis/tasks/' + v, { method: 'DELETE', headers: {} });",
      '',
    ].join('\n');
    expect(violations(src)).toEqual([]);
  });

  it('accepts the stored-bearer form only where it is allowed (debug page)', () => {
    const src = "const token = localStorage.getItem('vitana.authToken');\nfetch('/api/v1/tasks', { headers: token ? { Authorization: 'Bearer ' + token } : {} });\n";
    expect(violations(src)).toHaveLength(1);
    expect(violations(src, { storedBearer: true })).toEqual([]);
  });
});

describe('VTID-05063 Command Hub app.js', () => {
  it('the scanner sees the Tier 1 read call sites (guards against a silently empty scan)', () => {
    expect(tier1Reads(APP).length).toBeGreaterThanOrEqual(13);
  });

  it('every Tier 1 read sends buildContextHeaders()', () => {
    expect(violations(APP)).toEqual([]);
  });

  it('the fetch interceptor skips the refresh when the original request had no Authorization header', () => {
    const start = APP.indexOf('window.fetch = async function (input, init) {');
    expect(start).toBeGreaterThan(0);
    const not401 = APP.indexOf('if (resp.status !== 401) return resp;', start);
    const guard = APP.indexOf("if (!new Headers(origHeaders).has('Authorization')) return resp;", start);
    const refresh = APP.indexOf('var newToken = await performRefresh();', start);
    expect(not401).toBeGreaterThan(start);
    expect(guard).toBeGreaterThan(not401);
    expect(refresh).toBeGreaterThan(guard);
  });
});

describe('VTID-05063 Command Hub debug.html', () => {
  it('reads the stored bearer from localStorage vitana.authToken', () => {
    expect(DEBUG).toContain("localStorage.getItem('vitana.authToken')");
  });

  it('its Tier 1 read sends that bearer', () => {
    expect(tier1Reads(DEBUG).length).toBeGreaterThanOrEqual(1);
    expect(violations(DEBUG, { storedBearer: true })).toEqual([]);
  });
});
