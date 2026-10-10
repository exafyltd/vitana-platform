/**
 * VTID-05001 — the ORB widget honours the WebSocket kill switch, and every
 * overlay close reports which path closed it.
 *
 * 1. Transport: the compiled default is 'sse'. WebSocket is used only for an
 *    explicit server answer 'ws' (staging) or the developer override. Before
 *    this, a client whose GET /live/transport had not answered started on WS
 *    even while prod said off.
 * 2. Close reasons: `_hide(reason)` is called with an allowlisted literal at
 *    every site (checked on the parsed AST, so comments and strings never
 *    count), and the widget's list matches the route's allowlist.
 * 3. The continuity route keeps only allowlisted / clamped diagnostics.
 */

import * as fs from 'fs';
import * as path from 'path';
// eslint is a gateway devDependency; espree is its parser.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const espree = require('espree');
import {
  HIDE_REASONS,
  MAX_MS_SINCE_TAP,
  sanitizeHideDiagnostics,
} from '../../src/orb/live/session/hide-reasons';

const WIDGET = path.resolve(__dirname, '../../src/frontend/command-hub/orb-widget.js');
const ORB_LIVE = path.resolve(__dirname, '../../src/routes/orb-live.ts');
const source = fs.readFileSync(WIDGET, 'utf8');

type Node = { type: string; [k: string]: any };

function walk(node: Node, parent: Node | null, visit: (n: Node, p: Node | null) => void): void {
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const v = (node as any)[key];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, node, visit));
    else if (v && typeof v.type === 'string') walk(v, node, visit);
  }
}

function functionSource(name: string): string {
  const sig = `function ${name}(`;
  const start = source.indexOf(sig);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unclosed ${name}`);
}

describe('VTID-05001: transport choice honours the kill switch', () => {
  // Evaluate the real _useWsTransport/_wsFallbackLatched against stubs.
  function decide(opts: { override?: string | null; server?: string | null; latched?: boolean }): boolean {
    const store = (v: string | null) => ({ getItem: () => v, setItem: () => undefined });
    const factory = new Function(
      'window', 'localStorage', 'sessionStorage', '_serverTransport', '_cfg', '_s', '_WS_FALLBACK_KEY',
      `${functionSource('_wsFallbackLatched')}\n${functionSource('_useWsTransport')}\nreturn _useWsTransport();`,
    );
    const ls = store(opts.override ?? null);
    const ss = store(opts.latched ? '1' : null);
    const cfgDefault = /\n\s*transport:\s*'(ws|sse)'\s*\n\s*\};/.exec(source)![1];
    return factory({ localStorage: ls, sessionStorage: ss }, ls, ss, opts.server ?? null,
      { transport: cfgDefault }, {}, 'vtorb.wsFallback') as boolean;
  }

  it('uses SSE when the server has not answered', () => {
    expect(decide({})).toBe(false);
  });
  it('uses SSE when the server says sse', () => {
    expect(decide({ server: 'sse' })).toBe(false);
  });
  it('uses WS when the server says ws', () => {
    expect(decide({ server: 'ws' })).toBe(true);
  });
  it('lets the developer override win', () => {
    expect(decide({ override: 'ws', server: 'sse' })).toBe(true);
    expect(decide({ override: 'sse', server: 'ws' })).toBe(false);
  });
  it('keeps the per-tab fallback latch', () => {
    expect(decide({ server: 'ws', latched: true })).toBe(false);
  });
});

describe('VTID-05001: every overlay close names its path', () => {
  const ast = espree.parse(source, { ecmaVersion: 2020, sourceType: 'script', loc: true });

  const widgetReasons: string[] = (() => {
    let found: string[] | null = null;
    walk(ast, null, (n) => {
      if (n.type === 'VariableDeclarator' && n.id?.name === 'HIDE_REASONS' && n.init?.type === 'ArrayExpression') {
        found = n.init.elements.map((e: Node) => e.value);
      }
    });
    if (!found) throw new Error('HIDE_REASONS not found in orb-widget.js');
    return found;
  })();

  it("matches the route's allowlist exactly", () => {
    expect(widgetReasons).toEqual([...HIDE_REASONS]);
  });

  it('calls _hide only with an allowlisted string literal (never bare, never as a callback)', () => {
    const problems: string[] = [];
    let calls = 0;
    walk(ast, null, (n, p) => {
      if (n.type !== 'Identifier' || n.name !== '_hide') return;
      if (p?.type === 'FunctionDeclaration' && p.id === n) return; // the definition
      const line = n.loc?.start?.line;
      if (p?.type !== 'CallExpression' || p.callee !== n) {
        problems.push(`line ${line}: _hide used as a value — wrap it so it passes a reason`);
        return;
      }
      calls++;
      const arg = p.arguments[0];
      if (p.arguments.length !== 1 || arg.type !== 'Literal' || typeof arg.value !== 'string') {
        problems.push(`line ${line}: _hide called without a string-literal reason`);
      } else if (!widgetReasons.includes(arg.value) || arg.value === 'unknown') {
        problems.push(`line ${line}: _hide('${arg.value}') is not in HIDE_REASONS`);
      }
    });
    expect(problems).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(15);
  });

  it('_hide records the diagnostics before flushing the tap timeline and sends them with continuity', () => {
    const body = functionSource('_hide');
    expect(body.indexOf('_hideDiag(reason)')).toBeGreaterThan(0);
    expect(body.indexOf('_hideDiag(reason)')).toBeLessThan(body.indexOf('_latFlush()'));
    expect(body).toContain("_persistContinuity('hide', 15, hideDiag)");
    const persist = functionSource('_persistContinuity');
    for (const f of ['hide_reason', 'ms_since_tap', 'transport', 'start_phase']) {
      expect(persist).toContain(`${f}: diag ? diag.${f} : undefined`);
    }
  });

  it('_hideDiag falls back to unknown for a missing or unlisted reason', () => {
    const fn = new Function('HIDE_REASONS', '_s', '_latNow',
      `${functionSource('_hideDiag')}\nreturn _hideDiag;`)(widgetReasons, { active: false }, () => 0);
    expect(fn(undefined).hide_reason).toBe('unknown');
    expect(fn({ type: 'click' }).hide_reason).toBe('unknown');
    expect(fn('nope').hide_reason).toBe('unknown');
    expect(fn('fab_toggle')).toEqual({ hide_reason: 'fab_toggle', ms_since_tap: null, transport: null, start_phase: 'connecting' });
  });
});

describe('VTID-05001: continuity route keeps only clean diagnostics', () => {
  it('passes allowlisted values through', () => {
    expect(sanitizeHideDiagnostics({ hide_reason: 'view_role_change', ms_since_tap: 1312.6, transport: 'ws', start_phase: 'connecting' }))
      .toEqual({ hide_reason: 'view_role_change', ms_since_tap: 1313, transport: 'ws', start_phase: 'connecting' });
  });
  it('drops unknown or malformed values', () => {
    expect(sanitizeHideDiagnostics({ hide_reason: 'drop table', ms_since_tap: 'x', transport: 'http', start_phase: 'later' })).toEqual({});
    expect(sanitizeHideDiagnostics({ ms_since_tap: Number.NaN })).toEqual({});
    expect(sanitizeHideDiagnostics(null)).toEqual({});
  });
  it('clamps the tap interval', () => {
    expect(sanitizeHideDiagnostics({ ms_since_tap: -5 }).ms_since_tap).toBe(0);
    expect(sanitizeHideDiagnostics({ ms_since_tap: 1e12 }).ms_since_tap).toBe(MAX_MS_SINCE_TAP);
  });
  it('an older widget body (no new fields) adds nothing', () => {
    expect(sanitizeHideDiagnostics({ reason: 'hide', ttl_minutes: 15, value: {} })).toEqual({});
  });
  it('the continuity route spreads the sanitized fields into the persisted event only', () => {
    const src = fs.readFileSync(ORB_LIVE, 'utf8');
    const start = src.indexOf("router.post('/session/continuity'");
    const block = src.slice(start, src.indexOf('\n});', start));
    expect(block).toContain("type: 'orb.session.continuity.persisted'");
    expect(block).toContain('...sanitizeHideDiagnostics(body) }');
    // never written into the stored continuity row
    const write = block.slice(block.indexOf('writeOrbSessionState('), block.indexOf('}, ttl);'));
    expect(write).not.toContain('sanitizeHideDiagnostics');
  });
});
