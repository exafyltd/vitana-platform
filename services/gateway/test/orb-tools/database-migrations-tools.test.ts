/**
 * Developer Database & Migrations voice tools (Wave 6, plan section C11) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  DATABASE_MIGRATIONS_TOOL_HANDLERS,
  DATABASE_MIGRATIONS_TOOL_DECLARATIONS,
  dev_run_staging_migration,
  dev_run_prod_migration,
  dev_migration_status,
  dev_run_backfill,
} from '../../src/services/orb-tools/database-migrations-tools';

jest.mock('../../src/services/github-service', () => ({
  __esModule: true,
  default: {
    triggerWorkflow: jest.fn().mockResolvedValue(undefined),
    getWorkflowRuns: jest.fn().mockResolvedValue({ workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success', created_at: new Date().toISOString() }] }),
  },
}));

import githubService from '../../src/services/github-service';

const EXAFY_ID: OrbToolIdentity = { user_id: 'u-exafy', tenant_id: 't-1', role: 'exafy_admin', user_jwt: 'jwt-xyz' };
const DEV_ID: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer', user_jwt: 'jwt-dev' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'developer' };

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.clearAllMocks();
});

function mockFetch(status: number, body: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('catalogue', () => {
  const names = Object.keys(DATABASE_MIGRATIONS_TOOL_HANDLERS);

  it('exposes all 4 tools with matching declarations', () => {
    expect(names).toHaveLength(4);
    const declNames = DATABASE_MIGRATIONS_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const r = await DATABASE_MIGRATIONS_TOOL_HANDLERS[name](
      { migration_file: 'supabase/migrations/x.sql', reason: 'r', name: 'embeddings' },
      COMMUNITY_ID,
      {} as SupabaseClient,
    );
    expect(r.ok).toBe(false);
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await DATABASE_MIGRATIONS_TOOL_HANDLERS[name]({}, ANON_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });
});

describe('dev_run_staging_migration', () => {
  it('validates the migration_file path', async () => {
    const r = await dev_run_staging_migration({ migration_file: 'not/valid.sql' }, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('requires confirmation first', async () => {
    const r = await dev_run_staging_migration({ migration_file: 'supabase/migrations/x.sql' }, DEV_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('dispatches with the staging confirm phrase on confirm', async () => {
    const r = await dev_run_staging_migration({ migration_file: 'supabase/migrations/x.sql', confirm: true }, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(true);
    expect(githubService.triggerWorkflow).toHaveBeenCalledWith(
      'exafyltd/vitana-platform', 'RUN-STAGING-MIGRATION.yml', 'main',
      expect.objectContaining({ confirm: 'I-mean-staging' }),
    );
  });
});

describe('dev_run_prod_migration', () => {
  it('requires a reason', async () => {
    const r = await dev_run_prod_migration({ migration_file: 'supabase/migrations/x.sql' }, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('requires confirmation first', async () => {
    const r = await dev_run_prod_migration({ migration_file: 'supabase/migrations/x.sql', reason: 'hotfix' }, DEV_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('dispatches RUN-MIGRATION.yml on confirm', async () => {
    const r = await dev_run_prod_migration({ migration_file: 'supabase/migrations/x.sql', reason: 'hotfix', confirm: true }, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(true);
    expect(githubService.triggerWorkflow).toHaveBeenCalledWith('exafyltd/vitana-platform', 'RUN-MIGRATION.yml', 'main', { migration_file: 'supabase/migrations/x.sql' });
  });
});

describe('dev_migration_status', () => {
  it('defaults to staging', async () => {
    const r = await dev_migration_status({}, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(true);
    expect(githubService.getWorkflowRuns).toHaveBeenCalledWith('exafyltd/vitana-platform', 'RUN-STAGING-MIGRATION.yml');
  });

  it('switches to production when asked', async () => {
    const r = await dev_migration_status({ target: 'production' }, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(true);
    expect(githubService.getWorkflowRuns).toHaveBeenCalledWith('exafyltd/vitana-platform', 'RUN-MIGRATION.yml');
  });
});

describe('dev_run_backfill', () => {
  it('rejects an unknown name', async () => {
    const r = await dev_run_backfill({ name: 'bogus' }, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('journey_translations requires confirmation first', async () => {
    const r = await dev_run_backfill({ name: 'journey_translations' }, DEV_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('journey_translations dispatches on confirm', async () => {
    const r = await dev_run_backfill({ name: 'journey_translations', confirm: true }, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(true);
    expect(githubService.triggerWorkflow).toHaveBeenCalledWith('exafyltd/vitana-platform', 'JOURNEY-TRANSLATIONS-BACKFILL.yml', 'main', expect.any(Object));
  });

  it('embeddings requires exafy_admin even for a plain developer', async () => {
    const r = await dev_run_backfill({ name: 'embeddings' }, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('embeddings skips confirmation on dry_run for exafy_admin', async () => {
    mockFetch(200, { would_process: 5 });
    const r = await dev_run_backfill({ name: 'embeddings', dry_run: true }, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('5');
  });

  it('embeddings requires confirmation first for exafy_admin (non-dry-run)', async () => {
    const r = await dev_run_backfill({ name: 'embeddings' }, EXAFY_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});
