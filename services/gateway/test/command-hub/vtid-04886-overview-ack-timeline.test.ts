/**
 * Command Hub Overview Phase 3 — Ack / Snooze controls, the reason form, the
 * hidden list, the 24 h timeline, sparklines and the opt-in P1 browser
 * notification (VTID-04886). Source-level and sandboxed checks (app.js has no
 * build step); the rendered cockpit is checked offline in headless Chromium
 * (docs/validation/VTID-04886/outputs).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '../../src/frontend/command-hub/app.js'), 'utf8');
const CSS = readFileSync(join(__dirname, '../../src/frontend/command-hub/styles.css'), 'utf8');
const HTML = readFileSync(join(__dirname, '../../src/frontend/command-hub/index.html'), 'utf8');

function fnBody(signature: string): string {
  const start = SRC.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  return SRC.slice(start, SRC.indexOf('\n}', start) + 2);
}

function cockpitRegion(): string {
  const start = SRC.indexOf('// VTID-04876: Overview Phase 1 — the supervisor cockpit');
  const end = SRC.indexOf('function renderOverviewSystemView() {');
  expect(start).toBeGreaterThan(-1);
  return SRC.slice(start, SRC.indexOf('\n}', end) + 2);
}

/** The pure helpers, evaluated with a fake window/localStorage/Notification. */
function loadPure(win: any) {
  const parts = [
    SRC.slice(SRC.indexOf('var OPS_ATTENTION_NOTIFY_KEY'), SRC.indexOf('/** Off by default;')),
    fnBody('function escapeHtml(str) {'),
    fnBody('function opsAttentionNotifyEnabled() {'),
    fnBody('function opsAttentionSetNotify(on) {'),
    fnBody('function opsAttentionNewP1(seen, items) {'),
    fnBody('function opsAttentionP1Set(items) {'),
    fnBody('function opsAttentionMaybeNotify(data) {'),
    fnBody('function opsAttentionSparkSvg(buckets, label) {'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'state', `${parts}\nreturn { opsAttentionNotifyEnabled, opsAttentionSetNotify, opsAttentionNewP1, opsAttentionP1Set, opsAttentionMaybeNotify, opsAttentionSparkSvg, OPS_ATTENTION_DURATIONS };`)(win, win.__state);
}

function fakeWindow(opts: { storage?: 'ok' | 'throws'; permission?: string } = {}) {
  const store: Record<string, string> = {};
  const fired: Array<[string, any]> = [];
  const win: any = {
    __state: { opsAttention: { seenP1: null } },
    __fired: fired,
    localStorage: opts.storage === 'throws'
      ? { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } }
      : { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } },
  };
  function N(this: any, title: string, o: any) { fired.push([title, o]); }
  (N as any).permission = opts.permission ?? 'granted';
  win.Notification = N;
  return win;
}

const p1 = (fp: string) => ({ fingerprint: fp, severity: 'P1', title: `T ${fp}`, detail: 'd' });

describe('VTID-04886: opt-in P1 browser notifications', () => {
  it('off by default; the toggle is stored in localStorage; a throwing storage reads as off and never throws', () => {
    const w = fakeWindow();
    const p = loadPure(w);
    expect(p.opsAttentionNotifyEnabled()).toBe(false);
    expect(p.opsAttentionSetNotify(true)).toBe(true);
    expect(p.opsAttentionNotifyEnabled()).toBe(true);
    p.opsAttentionSetNotify(false);
    expect(p.opsAttentionNotifyEnabled()).toBe(false);
    const bad = loadPure(fakeWindow({ storage: 'throws' }));
    expect(bad.opsAttentionNotifyEnabled()).toBe(false);
    expect(bad.opsAttentionSetNotify(true)).toBe(false);
  });

  it('fires only when a NEW fingerprint reaches P1 — never on the first load, never twice, never for P2', () => {
    const w = fakeWindow();
    const p = loadPure(w);
    p.opsAttentionSetNotify(true);
    expect(p.opsAttentionMaybeNotify({ items: [p1('a')] })).toBe(0); // first load: seeds only
    expect(p.opsAttentionMaybeNotify({ items: [p1('a')] })).toBe(0); // same P1
    expect(p.opsAttentionMaybeNotify({ items: [p1('a'), p1('b'), { fingerprint: 'c', severity: 'P2', title: 'x' }] })).toBe(1);
    expect(w.__fired).toEqual([['P1 — T b', { body: 'd', tag: 'b' }]]);
    // A fingerprint that cleared and comes back is new again.
    p.opsAttentionMaybeNotify({ items: [] });
    expect(p.opsAttentionMaybeNotify({ items: [p1('a')] })).toBe(1);
  });

  it('does nothing when opted out or when the browser has not granted permission', () => {
    const off = fakeWindow();
    const p = loadPure(off);
    p.opsAttentionMaybeNotify({ items: [] });
    expect(p.opsAttentionMaybeNotify({ items: [p1('a')] })).toBe(0);
    const denied = fakeWindow({ permission: 'denied' });
    const q = loadPure(denied);
    q.opsAttentionSetNotify(true);
    q.opsAttentionMaybeNotify({ items: [] });
    expect(q.opsAttentionMaybeNotify({ items: [p1('a')] })).toBe(0);
    expect(denied.__fired).toEqual([]);
  });

  it('the toggle asks for permission only when turned on, and seeds the seen set (no burst)', () => {
    const t = fnBody('async function toggleOpsAttentionNotify() {');
    expect(t).toContain('window.Notification.requestPermission()');
    expect(t).toContain('state.opsAttention.seenP1 = opsAttentionP1Set(');
    expect(fnBody('async function fetchOpsAttention(silentRefresh) {')).toContain('opsAttentionMaybeNotify(body.data);');
    const bar = fnBody('function renderOpsAttentionStatusBar(view, nowMs) {');
    expect(bar).toContain('data-action="ops-attention-notify"');
    expect(bar).toContain("aria-pressed=\"' + (opsAttentionNotifyEnabled() ? 'true' : 'false') + '\"");
  });
});

describe('VTID-04886: Ack / Snooze controls', () => {
  it('every item has Ack; Snooze is not offered for P1', () => {
    const a = fnBody('function renderOpsAttentionItemActions(item) {');
    expect(a).toContain('data-action="ops-attention-ack"');
    expect(a).toContain("if (item.severity !== 'P1') {");
    expect(a).toContain('data-action="ops-attention-snooze"');
    expect(a).toContain('P1 cannot be snoozed');
  });

  it('the reason form: reason required (3–500), expiry choices capped at 24 h, optional VTID, submit + cancel', () => {
    const a = fnBody('function renderOpsAttentionItemActions(item) {');
    expect(a).toContain('<textarea name="reason" required minlength="3" maxlength="500"');
    expect(a).toContain('name="duration_minutes"');
    expect(a).toContain('pattern="VTID-[0-9]{4,5}"');
    expect(a).toContain('data-action="ops-attention-cancel"');
    expect(a).toContain('role="alert"');
    const w = fakeWindow();
    const durations = loadPure(w).OPS_ATTENTION_DURATIONS.map((d: any) => d.minutes);
    expect(Math.max(...durations)).toBe(1440);
  });

  it('submit POSTs {fingerprint, reason, duration_minutes, vtid?} to /ack or /snooze and refetches; errors stay in the form', () => {
    const sub = fnBody('async function handleOpsAttentionSubmit(ev) {');
    expect(sub).toContain('postOpsAttentionAction(form.action, body)');
    expect(sub).toContain('fetchOpsAttention(true)');
    expect(sub).toContain("form.error = 'Not saved: '");
    const post = fnBody('async function postOpsAttentionAction(action, body) {');
    expect(post).toContain("fetch('/api/v1/ops/attention/' + action");
    expect(post).toContain("method: 'POST'");
    expect(post).toContain('buildContextHeaders(');
  });

  it('a poll never wipes an open form (deferred until it closes)', () => {
    const r = fnBody('function refreshOpsAttentionPanel() {');
    expect(r).toContain('if (state.opsAttention.actionForm) {');
    expect(r).toContain('state.opsAttention.pendingRefresh = true;');
  });

  it('acked items are de-emphasised with who/why/until; snoozed items are listed, never silently dropped', () => {
    const item = fnBody('function renderOpsAttentionItemHtml(item) {');
    expect(item).toContain("' ops-item-acked'");
    expect(item).toContain('Snoozed, but it is P1 now — shown again');
    const q = fnBody('function renderOpsAttentionQueue(view) {');
    expect(q).toContain('snoozed item(s) hidden until they expire');
    expect(q).toContain('every item is shown');
    expect(fnBody('function renderOpsAttentionStatusBar(view, nowMs) {')).toContain('snoozed (hidden)');
  });

  it('delegated listeners only: no inline handler and no .style in the cockpit region', () => {
    const region = cockpitRegion();
    expect(region).not.toMatch(/onclick|onsubmit|\.style\b|style=/);
    expect(fnBody('function renderOpsAttentionCockpit() {')).toContain("wrap.addEventListener('submit', handleOpsAttentionSubmit);");
    const click = fnBody('function handleOpsAttentionClick(ev) {');
    for (const a of ['ops-attention-ack', 'ops-attention-snooze', 'ops-attention-cancel', 'ops-attention-notify']) expect(click).toContain(`'${a}'`);
  });
});

describe('VTID-04886: timeline and sparklines', () => {
  it('the sparkline is attribute-only SVG with an accessible label', () => {
    const svg = loadPure(fakeWindow()).opsAttentionSparkSvg([0, 2, 4], 'Deploys over 24 h');
    expect(svg).toContain('role="img" aria-label="Deploys over 24 h"');
    expect(svg).toContain('<rect x="6" y="0" width="2" height="16"></rect>');
    expect(svg).not.toMatch(/style/);
    expect(loadPure(fakeWindow()).opsAttentionSparkSvg([], 'x')).toContain('viewBox="0 0 0 16"');
  });

  it('the timeline renders newest first from data.timeline and says so when it could not be read', () => {
    const t = fnBody('function renderOpsAttentionTimeline(view) {');
    expect(t).toContain('tl.error');
    expect(t).toContain('this is not a quiet day');
    expect(fnBody('function renderOpsAttentionCockpit() {')).toContain('renderOpsAttentionTimeline(view)');
    expect(fnBody('function renderOpsAttentionStatusBar(view, nowMs) {')).toContain('Sparklines unavailable');
  });
});

describe('VTID-04886: styles and asset version', () => {
  it('the Phase 3 styles exist and use logical properties only; targets >= 24px', () => {
    const block = CSS.slice(CSS.indexOf('VTID-04886: Overview Phase 3'));
    for (const cls of ['.ops-item-acked', '.ops-action-form', '.ops-action-btn', '.ops-timeline-item', '.ops-spark-svg', '.ops-hidden']) expect(block).toContain(cls);
    expect(block).not.toMatch(/margin-left|margin-right|padding-left|padding-right|border-left|border-right|text-align:\s*left/);
    expect(block).toMatch(/\.ops-action-btn \{[^}]*min-height: 28px/);
  });

  it('index.html loads app.js and styles.css at (or after) the VTID-04886 version', () => {
    const app = (HTML.match(/app\.js\?v=([^"']+)/) || [])[1] || '';
    const css = (HTML.match(/styles\.css\?v=([^"']+)/) || [])[1] || '';
    expect(app >= '20261029-vtid-04886').toBe(true);
    expect(css >= '20261029-vtid-04886').toBe(true);
  });
});
