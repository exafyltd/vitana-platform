/**
 * VTID-05177 — shared harness for the native-push golden and routing suites.
 *
 * Not a test file (no `.test.ts`). It records, in order, every call the three
 * push dispatch sites make against the outside world:
 *   - every Supabase query (table + the full method chain with its arguments),
 *   - every FCM `messaging().send()` message,
 *   - every Appilix HTTP call (URL + form body),
 *   - every OASIS event,
 * so a test can compare one dispatch run with a recorded golden byte for byte.
 *
 * The Supabase fake is a tiny in-memory query engine (select / eq / neq / is /
 * in / like / lt / gte / order / limit / single / maybeSingle / insert /
 * update / upsert, plus `{ count: 'exact', head: true }`), so the real
 * repository seams run unmodified and the recorded chain is exactly the one
 * production code builds. Nothing here touches a real database or network.
 */

export type DbRow = Record<string, any>;

export type HarnessEvent =
  | { kind: 'db'; table: string; ops: Array<[string, ...any[]]> }
  | { kind: 'fcm'; message: any; result: string }
  | { kind: 'appilix'; url: string; body: string; delivered: boolean }
  | { kind: 'oasis'; event: any };

export interface HarnessState {
  tables: Record<string, DbRow[]>;
  events: HarnessEvent[];
  /** token → FCM behaviour; anything not listed is accepted. */
  fcm: Record<string, 'ok' | 'stale' | 'error'>;
  /** Appilix answer for every platform call. */
  appilix: 'delivered' | 'no_device';
  /** When set, any query on this table resolves with an error. */
  failTables: Set<string>;
  insertSeq: number;
}

export function newHarnessState(): HarnessState {
  return { tables: {}, events: [], fcm: {}, appilix: 'no_device', failTables: new Set(), insertSeq: 0 };
}

function likeToRegex(pattern: string): RegExp {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${esc}$`);
}

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

class FakeQuery {
  private filters: Array<(r: DbRow) => boolean> = [];
  private mode: 'select' | 'update' | 'insert' | 'upsert' = 'select';
  private cols = '*';
  private countHead = false;
  private payload: any = null;
  private singleMode: 'single' | 'maybeSingle' | null = null;
  private limitN: number | null = null;
  private selectAfterWrite = false;
  readonly ops: Array<[string, ...any[]]> = [];

  constructor(private state: HarnessState, private table: string) {
    state.events.push({ kind: 'db', table, ops: this.ops });
  }

  private rec(name: string, args: any[]) {
    this.ops.push([name, ...clone(args)]);
  }

  select(cols = '*', opts?: { count?: string; head?: boolean }) {
    this.rec('select', opts ? [cols, opts] : [cols]);
    if (this.mode !== 'select') this.selectAfterWrite = true;
    else {
      this.cols = cols;
      this.countHead = !!(opts?.head);
    }
    return this;
  }
  eq(c: string, v: any) { this.rec('eq', [c, v]); this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: any) { this.rec('neq', [c, v]); this.filters.push((r) => r[c] !== v); return this; }
  is(c: string, v: any) { this.rec('is', [c, v]); this.filters.push((r) => (r[c] ?? null) === v); return this; }
  in(c: string, vs: any[]) { this.rec('in', [c, vs]); this.filters.push((r) => vs.includes(r[c])); return this; }
  like(c: string, p: string) { this.rec('like', [c, p]); const re = likeToRegex(p); this.filters.push((r) => re.test(String(r[c] ?? ''))); return this; }
  lt(c: string, v: any) { this.rec('lt', [c, v]); this.filters.push((r) => r[c] < v); return this; }
  gte(c: string, v: any) { this.rec('gte', [c, v]); this.filters.push((r) => r[c] >= v); return this; }
  order(c: string, o?: any) { this.rec('order', o ? [c, o] : [c]); return this; }
  limit(n: number) { this.rec('limit', [n]); this.limitN = n; return this; }
  single() { this.rec('single', []); this.singleMode = 'single'; return this; }
  maybeSingle() { this.rec('maybeSingle', []); this.singleMode = 'maybeSingle'; return this; }
  update(patch: any) { this.rec('update', [patch]); this.mode = 'update'; this.payload = patch; return this; }
  insert(row: any) { this.rec('insert', [row]); this.mode = 'insert'; this.payload = row; return this; }
  upsert(row: any, opts?: any) { this.rec('upsert', opts ? [row, opts] : [row]); this.mode = 'upsert'; this.payload = row; return this; }

  private exec(): any {
    if (this.state.failTables.has(this.table)) {
      return { data: null, error: { message: `fake ${this.table} failure`, code: 'XX000' }, count: null };
    }
    const rows = (this.state.tables[this.table] ||= []);
    const match = (r: DbRow) => this.filters.every((f) => f(r));
    if (this.mode === 'update') {
      for (const r of rows) if (match(r)) Object.assign(r, this.payload);
      return { data: null, error: null };
    }
    if (this.mode === 'insert') {
      const row = { id: `row-${++this.state.insertSeq}`, ...this.payload };
      rows.push(row);
      const data = this.selectAfterWrite ? { id: row.id } : null;
      return { data, error: null };
    }
    if (this.mode === 'upsert') {
      rows.push({ ...this.payload });
      return { data: null, error: null };
    }
    let hit = rows.filter(match);
    if (this.limitN !== null) hit = hit.slice(0, this.limitN);
    if (this.countHead) return { data: null, count: hit.length, error: null };
    const project = (r: DbRow) => {
      if (this.cols.trim() === '*') return clone(r);
      const out: DbRow = {};
      for (const c of this.cols.split(',').map((s) => s.trim())) out[c] = r[c] ?? null;
      return out;
    };
    const data = hit.map(project);
    if (this.singleMode === 'single') {
      return data.length
        ? { data: data[0], error: null }
        : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    }
    if (this.singleMode === 'maybeSingle') return { data: data[0] ?? null, error: null };
    return { data, error: null, count: null };
  }

  then(resolve: (v: any) => any, reject?: (e: any) => any) {
    try {
      return Promise.resolve(this.exec()).then(resolve, reject);
    } catch (e) {
      return Promise.reject(e).then(resolve, reject);
    }
  }
}

export function makeFakeSupabase(state: HarnessState): any {
  return {
    from(table: string) {
      return new FakeQuery(state, table);
    },
  };
}

/** The FCM send the harness installs in place of firebase-admin's messaging(). */
export function makeFcmSend(getState: () => HarnessState) {
  return async (message: any) => {
    const state = getState();
    const behaviour = state.fcm[message.token] ?? 'ok';
    state.events.push({ kind: 'fcm', message: clone(message), result: behaviour });
    if (behaviour === 'stale') {
      const err: any = new Error('not registered');
      err.code = 'messaging/registration-token-not-registered';
      throw err;
    }
    if (behaviour === 'error') {
      const err: any = new Error('boom');
      err.code = 'messaging/internal-error';
      throw err;
    }
    return 'projects/x/messages/1';
  };
}

/** Global fetch stand-in for the Appilix API. */
export function makeAppilixFetch(getState: () => HarnessState) {
  return async (url: any, init?: any) => {
    const state = getState();
    const delivered = state.appilix === 'delivered';
    state.events.push({ kind: 'appilix', url: String(url), body: String(init?.body ?? ''), delivered });
    const text = delivered ? '{"status":true}' : '{"status":false,"message":"No devices found"}';
    return { ok: true, status: 200, text: async () => text } as any;
  };
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;

/** Serialise a recording with wall-clock timestamps replaced, for comparison. */
export function normalise(v: unknown): any {
  return JSON.parse(JSON.stringify(v ?? null).replace(ISO, '<ts>'));
}

// ── Scenario catalogue ────────────────────────────────────────────────────

export const USER = 'user-0000-aaaa';
export const OTHER_USER = 'user-0000-bbbb';
export const TENANT = 'tenant-0000-1111';
const REVOKED = '2026-08-03T20:21:22.000Z';

export const LABEL = {
  web: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0',
  appilix: 'Appilix Mozilla/5.0 (Linux; Android; K) App10 AppleWebKit/537.36',
  appilixUntagged: 'Mozilla/5.0 (Linux; Android; K) App10 AppleWebKit/537.36',
  nativeIos: 'native-ios 1.0.0',
  nativeAndroid: 'native-android 1.0.0',
};

function tok(fcm_token: string, device_label: string, extra: DbRow = {}): DbRow {
  return { user_id: USER, tenant_id: TENANT, fcm_token, device_label, revoked_at: null, device_type: null, ...extra };
}

export interface TokenMix {
  name: string;
  rows: DbRow[];
  fcm?: Record<string, 'ok' | 'stale' | 'error'>;
}

export const TOKEN_MIXES: TokenMix[] = [
  { name: 'none', rows: [] },
  { name: 'web', rows: [tok('tok-web', LABEL.web)] },
  { name: 'appilix', rows: [tok('tok-app', LABEL.appilix)] },
  { name: 'web+appilix', rows: [tok('tok-web', LABEL.web), tok('tok-app', LABEL.appilix)] },
  { name: 'native-ios', rows: [tok('tok-ios', LABEL.nativeIos, { device_type: 'ios_native', app_version: '1.0.0' })] },
  { name: 'native-android', rows: [tok('tok-and', LABEL.nativeAndroid, { device_type: 'android_native', app_version: '1.0.0' })] },
  {
    name: 'native-ios+appilix+web',
    rows: [
      tok('tok-ios', LABEL.nativeIos, { device_type: 'ios_native', app_version: '1.0.0' }),
      tok('tok-app', LABEL.appilix),
      tok('tok-web', LABEL.web),
    ],
  },
  {
    name: 'native-ios+native-android',
    rows: [
      tok('tok-ios', LABEL.nativeIos, { device_type: 'ios_native', app_version: '1.0.0' }),
      tok('tok-and', LABEL.nativeAndroid, { device_type: 'android_native', app_version: '1.0.0' }),
    ],
  },
  { name: 'signed-out', rows: [tok('tok-web', LABEL.web, { revoked_at: REVOKED })] },
  {
    name: 'lost-phone',
    rows: [
      tok('tok-app', LABEL.appilixUntagged, { revoked_at: REVOKED }),
      tok('tok-web', LABEL.web),
      { ...tok('tok-app', LABEL.appilixUntagged), user_id: OTHER_USER },
    ],
  },
  { name: 'web-stale', rows: [tok('tok-web', LABEL.web)], fcm: { 'tok-web': 'stale' } },
  { name: 'web-error', rows: [tok('tok-web', LABEL.web)], fcm: { 'tok-web': 'error' } },
  { name: 'native-ios-stale', rows: [tok('tok-ios', LABEL.nativeIos, { device_type: 'ios_native', app_version: '1.0.0' })], fcm: { 'tok-ios': 'stale' } },
];

export interface Scenario {
  key: string;
  mix: TokenMix;
  withUrl: boolean;
  appilix: 'delivered' | 'no_device';
}

export function allScenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const mix of TOKEN_MIXES) {
    for (const withUrl of [true, false]) {
      for (const appilix of ['delivered', 'no_device'] as const) {
        out.push({ key: `${mix.name}|${withUrl ? 'url' : 'no-url'}|appilix-${appilix}`, mix, withUrl, appilix });
      }
    }
  }
  return out;
}

export function seedState(state: HarnessState, s: Scenario): void {
  state.tables = { user_device_tokens: clone(s.mix.rows) };
  state.events = [];
  state.fcm = { ...(s.mix.fcm || {}) };
  state.appilix = s.appilix;
  state.failTables = new Set();
  state.insertSeq = 0;
}

export function pushPayload(withUrl: boolean) {
  return {
    title: 'Neuer Beitrag',
    body: 'Jemand hat etwas geteilt',
    data: withUrl ? { url: '/comm/post/p-1', entity_id: 'p-1' } : { entity_id: 'p-1' },
    tag: 'post_like:p-1',
  };
}
