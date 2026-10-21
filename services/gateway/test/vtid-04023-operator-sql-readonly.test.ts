/**
 * VTID-04023 (W5b): dev_run_sql_readonly — one bounded read-only statement
 * over a dedicated connection. Pins the statement validator (shape, single
 * statement, comment stripping, forbidden server-side functions/clauses),
 * the bounding (LIMIT wrap, rows, cells, total budget), the transaction
 * discipline (BEGIN READ ONLY + SET LOCAL timeouts + ROLLBACK, also on
 * failure), the not_configured posture, and the tool wiring (kill switch,
 * role gate, argument check, verbatim Postgres error).
 */

jest.mock('node-fetch');
jest.mock('../src/services/github-service', () => ({ searchCode: jest.fn(), getFileContents: jest.fn(), listOpenPrsWithStatus: jest.fn() }));
jest.mock('../src/services/aws-ecs-readonly', () => ({ describeEcsServices: jest.fn(), ALLOWED_ECS_SERVICES: ['vitana-gateway'], ALLOWED_ECS_TASK_FAMILIES: ['vitana-autopilot-executor'], TASKS_DEFAULT_LIMIT: 10, TASKS_MAX_LIMIT: 25, listEcsTasks: jest.fn() }));
jest.mock('@aws-sdk/client-cloudwatch-logs', () => ({ CloudWatchLogsClient: jest.fn(), FilterLogEventsCommand: jest.fn() }));

const pgConnect = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ connect: pgConnect, on: jest.fn() })),
}));

import { executeTool, setThreadIdentity } from '../src/services/gemini-operator';
import {
  SQL_CELL_MAX_CHARS, SQL_DEFAULT_ROWS, SQL_DEFAULT_TIMEOUT_MS, SQL_MAX_CHARS, SQL_MAX_ROWS, SQL_MAX_TIMEOUT_MS,
  boundRows, boundStatement, clampRows, clampTimeoutMs, resetSqlReadonlyPool, runReadonlySql, stripSqlComments, validateReadonlySql,
  type RoClient,
} from '../src/services/operator-sql-readonly';

function fakeClient(rows: Array<Record<string, unknown>> | Error): { client: RoClient; log: string[]; released: () => boolean } {
  const log: string[] = [];
  let released = false;
  const client: RoClient = {
    async query(sql: string) {
      log.push(sql);
      if (sql.startsWith('SELECT * FROM (') || sql.startsWith('EXPLAIN')) {
        if (rows instanceof Error) throw rows;
        return { rows };
      }
      return { rows: [] };
    },
    release() { released = true; },
  };
  return { client, log, released: () => released };
}

describe('VTID-04023 validateReadonlySql (pure)', () => {
  it('accepts SELECT, WITH … SELECT and plain EXPLAIN, tolerating one trailing semicolon', () => {
    expect(validateReadonlySql('select 1;')).toEqual({ sql: 'select 1', kind: 'select' });
    expect(validateReadonlySql('  WITH x AS (select 1) SELECT * FROM x')).toMatchObject({ kind: 'with' });
    expect(validateReadonlySql('EXPLAIN select * from vtid_ledger')).toMatchObject({ kind: 'explain' });
    expect(validateReadonlySql('explain (format json) select 1')).toMatchObject({ kind: 'explain' });
  });

  it('rejects every non-read statement shape', () => {
    for (const bad of [
      'insert into x values (1)', 'update x set a=1', 'delete from x', 'create table x(a int)', 'drop table x',
      'alter table x add b int', 'truncate x', 'call f()', 'set role service_role', 'begin', 'commit', 'grant all on x to y',
      'vacuum', 'do $$ begin end $$',
    ]) {
      expect(() => validateReadonlySql(bad)).toThrow(/only a single SELECT/);
    }
  });

  it('rejects a second statement, EXPLAIN ANALYZE, data-modifying CTEs and empty/oversized input', () => {
    expect(() => validateReadonlySql('select 1; delete from x')).toThrow(/exactly one statement/);
    expect(() => validateReadonlySql('select 1;; select 2')).toThrow(/exactly one statement/);
    expect(() => validateReadonlySql('explain analyze select 1')).toThrow(/EXPLAIN ANALYZE/);
    expect(() => validateReadonlySql('explain (analyze, buffers) select 1')).toThrow(/EXPLAIN ANALYZE/);
    expect(() => validateReadonlySql('with d as (delete from x returning *) select * from d')).toThrow(/data-modifying CTEs/);
    expect(() => validateReadonlySql('with x as (values (1)) values (2)')).toThrow(/must end in a SELECT/);
    expect(() => validateReadonlySql('')).toThrow(/sql is required/);
    expect(() => validateReadonlySql('-- only a comment')).toThrow(/sql is required/);
    expect(() => validateReadonlySql(`select '${'x'.repeat(SQL_MAX_CHARS)}'`)).toThrow(/max 4000/);
  });

  it('strips comments so a keyword cannot hide behind one, and refuses the forbidden server-side functions/clauses', () => {
    expect(stripSqlComments('select 1 -- ; delete\n/* drop */ from x')).toBe('select 1  \n  from x');
    expect(validateReadonlySql('/* leading */ select 1 -- trailing')).toEqual({ sql: 'select 1', kind: 'select' });
    expect(() => validateReadonlySql('select 1 /* ; */ ; select 2')).toThrow(/exactly one statement/);
    const forbidden: Array<[string, RegExp]> = [
      ['select pg_sleep(10)', /pg_sleep/],
      ['select PG_SLEEP_FOR(interval \'1s\')', /pg_sleep/],
      ['select pg_read_file(\'/etc/passwd\')', /pg_read_file/],
      ['select pg_terminate_backend(1)', /backend signalling/],
      ['select set_config(\'a\',\'b\',false)', /set_config/],
      ['select * from dblink(\'x\',\'y\') as t(a int)', /dblink/],
      ['select lo_export(1, \'/tmp/x\')', /large-object/],
      ['select nextval(\'s\')', /nextval/],
      ['select * from x for update', /row locking/],
      ['select * from x for no key update', /row locking/],
      ['select * into new_table from x', /SELECT INTO/],
      ['select * into temp t from x', /SELECT INTO/],
      ['copy x to stdout', /only a single SELECT/],
    ];
    for (const [sql, why] of forbidden) expect(() => validateReadonlySql(sql)).toThrow(why);
  });
});

describe('VTID-04023 bounding (pure)', () => {
  it('clamps rows and timeout with defaults and caps', () => {
    expect(clampRows(undefined)).toBe(SQL_DEFAULT_ROWS);
    expect(clampRows(0)).toBe(SQL_DEFAULT_ROWS);
    expect(clampRows(7.9)).toBe(7);
    expect(clampRows(10_000)).toBe(SQL_MAX_ROWS);
    expect(clampTimeoutMs('x')).toBe(SQL_DEFAULT_TIMEOUT_MS);
    expect(clampTimeoutMs(99_999)).toBe(SQL_MAX_TIMEOUT_MS);
  });

  it('wraps SELECT/WITH in a LIMIT n+1 outer query and leaves EXPLAIN alone', () => {
    expect(boundStatement({ sql: 'select * from t', kind: 'select' }, 50)).toBe('SELECT * FROM (\nselect * from t\n) AS _operator_ro LIMIT 51');
    expect(boundStatement({ sql: 'with a as (select 1) select * from a', kind: 'with' }, 5)).toContain('LIMIT 6');
    expect(boundStatement({ sql: 'explain select 1', kind: 'explain' }, 5)).toBe('explain select 1');
  });

  it('clips cells, renders dates/bigints/objects, flags the n+1 row as truncation, and stops at the total budget', () => {
    const d = new Date('2026-09-17T21:00:00Z');
    const r = boundRows([{ a: 'x'.repeat(SQL_CELL_MAX_CHARS + 10), b: d, c: BigInt(7), d: { k: 1 }, e: null, f: 3 }], 50);
    expect(r.columns).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect((r.rows[0].a as string).length).toBe(SQL_CELL_MAX_CHARS + 1);
    expect(r.rows[0]).toMatchObject({ b: d.toISOString(), c: '7', d: '{"k":1}', e: null, f: 3 });
    expect(r.truncated).toBe(false);
    const over = boundRows(Array.from({ length: 4 }, (_, i) => ({ i })), 3);
    expect(over.row_count).toBe(3);
    expect(over.truncated).toBe(true);
    expect(over.note).toMatch(/truncated at 3 rows/);
    const budget = boundRows(Array.from({ length: 100 }, () => ({ s: 'z'.repeat(300) })), 100, 1_000);
    expect(budget.row_count).toBe(3);
    expect(budget.truncated).toBe(true);
    expect(boundRows([], 10).note).toBe('no rows returned');
  });
});

describe('VTID-04023 runReadonlySql (transaction discipline)', () => {
  beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  it('runs BEGIN READ ONLY, SET LOCAL timeouts, the bounded statement, then ROLLBACK and release', async () => {
    const { client, log, released } = fakeClient([{ n: 1 }]);
    let t = 1_000; const now = () => (t += 40);
    const r = await runReadonlySql({ sql: 'select count(*) as n from vtid_ledger;', timeout_ms: 3_000, max_rows: 5 }, { pool: { connect: async () => client }, now, threadId: 'th1' });
    expect(log).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 3000',
      'SET LOCAL lock_timeout = 2000',
      'SET LOCAL idle_in_transaction_session_timeout = 8000',
      'SELECT * FROM (\nselect count(*) as n from vtid_ledger\n) AS _operator_ro LIMIT 6',
      'ROLLBACK',
    ]);
    expect(released()).toBe(true);
    expect(r).toMatchObject({ kind: 'select', rows: [{ n: 1 }], row_count: 1, truncated: false, read_only_transaction: true, duration_ms: 40 });
    expect(r.statement_fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('still ROLLBACKs and releases when the statement fails, and rethrows the Postgres error verbatim', async () => {
    const { client, log, released } = fakeClient(new Error('permission denied for table secrets'));
    await expect(runReadonlySql({ sql: 'select * from secrets' }, { pool: { connect: async () => client } })).rejects.toThrow('permission denied for table secrets');
    expect(log[log.length - 1]).toBe('ROLLBACK');
    expect(released()).toBe(true);
  });

  it('validates before touching the pool, and reports not_configured when no URL is set', async () => {
    const connect = jest.fn();
    await expect(runReadonlySql({ sql: 'delete from x' }, { pool: { connect } })).rejects.toThrow(/only a single SELECT/);
    expect(connect).not.toHaveBeenCalled();
    resetSqlReadonlyPool();
    await expect(runReadonlySql({ sql: 'select 1' }, { env: { OPERATOR_SQL_READONLY_ENABLED: 'true' } as NodeJS.ProcessEnv })).rejects.toThrow(/not_configured: .*OPERATOR_SQL_READONLY_DATABASE_URL/);
  });
});

describe('VTID-04023 dev_run_sql_readonly tool wiring', () => {
  const ORIGINAL_ENV = process.env;
  const DEV_THREAD = 'thread-dev-sql';
  const NON_DEV_THREAD = 'thread-community-sql';

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, OPERATOR_SQL_READONLY_ENABLED: 'true', OPERATOR_SQL_READONLY_DATABASE_URL: 'postgres://ro:x@reader.example/vitana', SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE: 'test-key' };
    pgConnect.mockReset();
    resetSqlReadonlyPool();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    setThreadIdentity(DEV_THREAD, { tenant_id: 't1', user_id: 'u1', role: 'developer' });
    setThreadIdentity(NON_DEV_THREAD, { tenant_id: 't1', user_id: 'u2', role: 'community' });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('is blocked for a non-developer role', async () => {
    const r = await executeTool('dev_run_sql_readonly', { sql: 'select 1' }, NON_DEV_THREAD);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Access denied/);
    expect(pgConnect).not.toHaveBeenCalled();
  });

  it('is kill-switched off by default', async () => {
    delete process.env.OPERATOR_SQL_READONLY_ENABLED;
    const r = await executeTool('dev_run_sql_readonly', { sql: 'select 1' }, DEV_THREAD);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/operator_sql_readonly_disabled/);
    expect(pgConnect).not.toHaveBeenCalled();
  });

  it('reports not_configured honestly when the URL is unset, and requires sql', async () => {
    delete process.env.OPERATOR_SQL_READONLY_DATABASE_URL;
    resetSqlReadonlyPool();
    expect((await executeTool('dev_run_sql_readonly', {}, DEV_THREAD)).error).toMatch(/sql is required/);
    const r = await executeTool('dev_run_sql_readonly', { sql: 'select 1' }, DEV_THREAD);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Read-only SQL failed: not_configured/);
    expect(pgConnect).not.toHaveBeenCalled();
  });

  it('refuses a write without opening a connection', async () => {
    const r = await executeTool('dev_run_sql_readonly', { sql: 'update vtid_ledger set status = \'completed\'' }, DEV_THREAD);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/only a single SELECT/);
    expect(pgConnect).not.toHaveBeenCalled();
  });

  it('returns the bounded rows for a developer through the pooled read-only connection', async () => {
    const { client, log } = fakeClient([{ stage: 'ci', failed: 3 }]);
    pgConnect.mockResolvedValue(client);
    const r = await executeTool('dev_run_sql_readonly', { sql: 'select stage, count(*) as failed from dev_autopilot_executions where status = \'failed\' group by stage', max_rows: 20 }, DEV_THREAD);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ kind: 'select', rows: [{ stage: 'ci', failed: 3 }], row_count: 1, read_only_transaction: true });
    expect(log[0]).toBe('BEGIN READ ONLY');
    expect(log[log.length - 1]).toBe('ROLLBACK');
    expect(log.find((l) => l.startsWith('SELECT * FROM ('))).toContain('LIMIT 21');
  });

  it('surfaces a Postgres failure verbatim instead of an empty result', async () => {
    const { client } = fakeClient(new Error('canceling statement due to statement timeout'));
    pgConnect.mockResolvedValue(client);
    const r = await executeTool('dev_run_sql_readonly', { sql: 'select * from oasis_events' }, DEV_THREAD);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Read-only SQL failed: canceling statement due to statement timeout');
  });
});
