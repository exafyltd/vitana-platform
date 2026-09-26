/**
 * VTID-04624: dev_run_sql_readonly reads the LIVE database through
 * public.operator_readonly_query when no dedicated read-only URL exists
 * (owner decision 2026-09-26). The dedicated URL, when present, still wins.
 */
import * as fs from 'fs';
import * as path from 'path';
import { runReadonlySql, sqlReadonlyBackend, resetSqlReadonlyPool } from '../src/services/operator-sql-readonly';

const ENV = {
  OPERATOR_SQL_READONLY_ENABLED: 'true',
  OPERATOR_SQL_READONLY_BACKEND: 'supabase',
  SUPABASE_URL: 'https://db.example.test',
  SUPABASE_SERVICE_ROLE: 'service-key',
} as unknown as NodeJS.ProcessEnv;

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = jest.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

beforeEach(() => {
  resetSqlReadonlyPool();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('sqlReadonlyBackend', () => {
  it('prefers the dedicated URL, then the supabase backend, else none', () => {
    expect(sqlReadonlyBackend({ ...ENV, OPERATOR_SQL_READONLY_DATABASE_URL: 'postgres://x' })).toBe('pool');
    expect(sqlReadonlyBackend(ENV)).toBe('supabase');
    expect(sqlReadonlyBackend({ ...ENV, OPERATOR_SQL_READONLY_BACKEND: 'Supabase' })).toBeNull();
    expect(sqlReadonlyBackend({ ...ENV, SUPABASE_SERVICE_ROLE: '' })).toBeNull();
    expect(sqlReadonlyBackend({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('runReadonlySql on the supabase backend', () => {
  it('posts the bounded statement to operator_readonly_query with the service role and returns bounded rows', async () => {
    const { fn, calls } = fakeFetch(200, [{ n: 224 }]);
    const out = await runReadonlySql({ sql: 'select count(*) as n from public.app_users;' }, { env: ENV, fetchImpl: fn });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://db.example.test/rest/v1/rpc/operator_readonly_query');
    expect(calls[0].init.headers.Authorization).toBe('Bearer service-key');
    const q = JSON.parse(calls[0].init.body).q;
    expect(q).toContain('select count(*) as n from public.app_users');
    expect(q).toMatch(/LIMIT 51$/);
    expect(out).toEqual(expect.objectContaining({ rows: [{ n: 224 }], row_count: 1, kind: 'select', read_only_transaction: true }));
  });

  it('validates before any request: a write never reaches the database', async () => {
    const { fn, calls } = fakeFetch(200, []);
    await expect(runReadonlySql({ sql: 'delete from public.app_users' }, { env: ENV, fetchImpl: fn })).rejects.toThrow(/only a single SELECT/);
    await expect(runReadonlySql({ sql: 'select 1; select 2' }, { env: ENV, fetchImpl: fn })).rejects.toThrow(/exactly one statement/);
    expect(calls).toHaveLength(0);
  });

  it('refuses EXPLAIN on this backend with a clear reason', async () => {
    const { fn, calls } = fakeFetch(200, []);
    await expect(runReadonlySql({ sql: 'explain select 1' }, { env: ENV, fetchImpl: fn })).rejects.toThrow(/EXPLAIN is not available on the live-database backend/);
    expect(calls).toHaveLength(0);
  });

  it('passes the database error through verbatim', async () => {
    const { fn } = fakeFetch(400, { message: 'cannot execute INSERT in a read-only transaction', code: '25006' });
    await expect(runReadonlySql({ sql: 'select public.some_writer()' }, { env: ENV, fetchImpl: fn }))
      .rejects.toThrow(/HTTP 400\): cannot execute INSERT in a read-only transaction/);
  });

  it('the dedicated URL still takes the pool path', () => {
    expect(sqlReadonlyBackend({ ...ENV, OPERATOR_SQL_READONLY_DATABASE_URL: 'postgres://ro@reader/vitana' })).toBe('pool');
  });
});

describe('the migration and the staging wiring', () => {
  const root = path.resolve(__dirname, '../../..');
  it('the function is service_role-only and switches the transaction to read-only before executing', () => {
    const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20260926110000_vtid_04624_operator_readonly_query.sql'), 'utf8');
    expect(sql).toMatch(/security invoker/);
    const ro = sql.indexOf("set_config('transaction_read_only', 'on', true)");
    const exec = sql.indexOf('execute format(');
    expect(ro).toBeGreaterThan(0);
    expect(exec).toBeGreaterThan(ro);
    for (const r of ['public', 'anon', 'authenticated']) expect(sql).toContain(`revoke all on function public.operator_readonly_query(text) from ${r};`);
    expect(sql).toContain('grant execute on function public.operator_readonly_query(text) to service_role;');
  });

  it('staging enables the supabase backend when the URL secret is absent; prod declares nothing', () => {
    const staging = fs.readFileSync(path.join(root, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
    expect(staging).toContain('{name:"OPERATOR_SQL_READONLY_ENABLED", value:"true"}, {name:"OPERATOR_SQL_READONLY_BACKEND", value:"supabase"}');
    expect(staging).toContain('"OPERATOR_SQL_READONLY_ENABLED","OPERATOR_SQL_READONLY_BACKEND",');
    const prod = fs.readFileSync(path.join(root, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
    expect(prod).not.toContain('OPERATOR_SQL_READONLY_BACKEND');
  });
});
