/**
 * VTID-04798: memory plan phase 3 — a work conversation never writes the
 * member's personal facts, and Art. 9 facts never reach another member.
 * The sensitivity rule itself is tested on a throwaway Postgres by
 * scripts/ci/sql-tests/run-memory-sensitivity-test.sh (CI: SQL-MEMORY-SENSITIVITY.yml).
 */
import * as fs from 'fs';
import * as path from 'path';

const mockExtract = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../src/services/inline-fact-extractor', () => ({
  extractAndPersistFacts: (...a: unknown[]) => mockExtract(...a),
  isInlineExtractionAvailable: () => true,
}));

import { WORK_ROLES, isWorkRole, mayWritePersonalFacts, memoryRoleForWrite } from '../../../src/services/memory/scope';
import { WORK_SURFACE_ROLE } from '../../../src/orb/profile/assistant-profile';
import { deduplicatedExtract, clearExtractionState } from '../../../src/services/extraction-dedup-manager';
import { commitSessionMemory } from '../../../src/services/session-memory-commit';
import { conversationChannelRole } from '../../../src/services/conversation-client';
import {
  maybeRunRememberBackstop,
  maybeRunForgetBackstop,
  maybeRunRecallBackstop,
} from '../../../src/orb/live/session/remember-backstop-hook';
import { searchMemoryFactsByKeyword } from '../../../src/services/voice-tools/community-member-ranker-repository';

const TEXT = 'User: Mein Projekt ist am Freitag fällig und meine Frau heißt Maria.\nAssistant: Notiert.';
const ID = { tenant_id: '22222222-2222-2222-2222-222222222222', user_id: '11111111-1111-1111-1111-111111111111' };

beforeEach(() => mockExtract.mockClear());

describe('VTID-04798 scope rule', () => {
  it('the work roles are exactly the roles the work surfaces serve', () => {
    expect([...WORK_ROLES].sort()).toEqual(Object.values(WORK_SURFACE_ROLE).sort());
  });

  it('member-plane and database roles may write personal facts; work roles and work surfaces may not', () => {
    for (const role of [null, undefined, '', 'community', 'patient', 'professional', 'staff', 'authenticated', 'user']) {
      expect(mayWritePersonalFacts({ role })).toBe(true);
    }
    for (const role of ['developer', 'admin', 'backoffice', 'commerce', ' Developer ']) {
      expect(isWorkRole(role)).toBe(true);
      expect(mayWritePersonalFacts({ role })).toBe(false);
    }
    // An unverified work surface has no role yet; the surface alone decides.
    expect(mayWritePersonalFacts({ workSurface: true, role: null })).toBe(false);
    expect(mayWritePersonalFacts({ workSurface: true, role: 'community' })).toBe(false);
  });

  it('memory_items role stamping is unchanged', () => {
    expect(memoryRoleForWrite('community')).toBeNull();
    expect(memoryRoleForWrite('developer')).toBe('developer');
  });
});

describe('VTID-04798 deduplicatedExtract', () => {
  it('skips a work-surface conversation and starts no extraction', () => {
    const r = deduplicatedExtract({ conversationText: TEXT, ...ID, session_id: 'ws-1', force: true, work_surface: true });
    expect(r).toEqual({ extracted: false, skip_reason: 'work_surface' });
    const r2 = deduplicatedExtract({ conversationText: TEXT, ...ID, session_id: 'ws-2', force: true, served_role: 'admin' });
    expect(r2.skip_reason).toBe('work_surface');
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it('a member conversation still extracts', () => {
    const r = deduplicatedExtract({ conversationText: TEXT, ...ID, session_id: 'm-1', force: true, work_surface: false, served_role: 'community' });
    expect(r.extracted).toBe(true);
    expect(mockExtract).toHaveBeenCalledTimes(1);
    clearExtractionState('m-1');
  });
});

describe('VTID-04798 session-end commit', () => {
  const base = { transcript: TEXT.repeat(3), tenantId: ID.tenant_id, userId: ID.user_id };

  it('a work-surface session commits no facts', () => {
    commitSessionMemory({ ...base, sessionId: 'commit-ws', activeRole: 'developer', workSurface: true });
    commitSessionMemory({ ...base, sessionId: 'commit-ws-role', activeRole: 'backoffice' });
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it('a member session commits facts', () => {
    commitSessionMemory({ ...base, sessionId: 'commit-member', activeRole: 'community', workSurface: false });
    expect(mockExtract).toHaveBeenCalledTimes(1);
  });
});

describe('VTID-04798 text channels', () => {
  it('Operator Console and developer assistant turns are developer memory; ORB text is personal', () => {
    expect(conversationChannelRole('operator')).toBe('developer');
    expect(conversationChannelRole('developer_assistant')).toBe('developer');
    expect(conversationChannelRole('orb')).toBeNull();
    expect(mayWritePersonalFacts({ role: conversationChannelRole('operator') })).toBe(false);
  });
});

describe('VTID-04798 voice backstops stay off work surfaces', () => {
  const prev = process.env.ORB_REMEMBER_BACKSTOP_ENABLED;
  beforeAll(() => { process.env.ORB_REMEMBER_BACKSTOP_ENABLED = 'true'; });
  afterAll(() => { if (prev === undefined) delete process.env.ORB_REMEMBER_BACKSTOP_ENABLED; else process.env.ORB_REMEMBER_BACKSTOP_ENABLED = prev; });

  const session = (isWorkSurface: boolean) => ({
    sessionId: 's', active: true, upstreamProvider: 'nova_sonic',
    identity: { ...ID },
    upstreamClient: { sendTextTurn: () => true },
    assistantProfile: { isWorkSurface },
  });
  const ctx: any = { emitDiag: () => undefined, deps: {} };

  const deps = () => ({
    readCurrentFact: jest.fn(async () => null),
    readProfileValue: jest.fn(async () => null),
    listCurrentFacts: jest.fn(async () => []),
    write: jest.fn(async () => ({ ok: true, fact_id: 'f1' })),
    extract: jest.fn(async () => []),
    pendingConflicts: { get: () => [], set: () => undefined, clear: () => undefined },
  }) as any;

  it('the remember backstop runs on a member surface (control)', async () => {
    const run = maybeRunRememberBackstop(ctx, session(false) as any, 'Merk dir, meine Frau heißt Maria.', deps(), '');
    expect(run).not.toBeNull();
    await run!.catch(() => undefined);
  });

  it('remember, forget and recall backstops return nothing on a work surface', () => {
    expect(maybeRunRememberBackstop(ctx, session(true) as any, 'Merk dir, meine Frau heißt Maria.', deps(), '')).toBeNull();
    expect(maybeRunForgetBackstop(ctx, session(true) as any, 'Vergiss den Namen meiner Frau.')).toBeNull();
    expect(maybeRunRecallBackstop(ctx, session(true) as any, 'Wie heißt meine Frau?', 'Das habe ich nicht gespeichert.')).toBeNull();
  });
});

describe('VTID-04798 member ranker', () => {
  it('matches another member only on standard facts', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const chain: any = new Proxy({}, {
      get: (_t, prop: string) => (...args: unknown[]) => { calls.push([prop, args]); return prop === 'limit' ? Promise.resolve({ data: [] }) : chain; },
    });
    await searchMemoryFactsByKeyword(chain, '%diabetes%');
    expect(calls).toContainEqual(['eq', ['sensitivity', 'standard']]);
  });

  it('no longer reads health_features_daily to describe another member', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/services/voice-tools/community-member-ranker.ts'), 'utf8');
    const repo = fs.readFileSync(path.join(__dirname, '../../../src/services/voice-tools/community-member-ranker-repository.ts'), 'utf8');
    expect(src).not.toContain('searchHealthFeaturesByKeyword');
    expect(repo).not.toContain("from('health_features_daily')");
  });
});

describe('VTID-04798 migration', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '../../../../../supabase/migrations/20261001160000_vtid_04798_memory_sensitivity.sql'),
    'utf8',
  );

  it('adds a constrained sensitivity column to both memory tables', () => {
    for (const t of ['memory_facts', 'memory_items']) {
      expect(sql).toContain(`alter table public.${t}\n  add column if not exists sensitivity text not null default 'standard';`);
      expect(sql).toContain(`${t}_sensitivity_check check (sensitivity in ('standard', 'special_category'))`);
    }
  });

  it('classifies every write in the database and backfills existing rows', () => {
    expect(sql).toMatch(/create trigger trg_memory_facts_sensitivity\s+before insert or update of fact_key, sensitivity on public\.memory_facts/);
    expect(sql).toMatch(/create trigger trg_memory_items_sensitivity\s+before insert or update of category_key, sensitivity on public\.memory_items/);
    expect(sql).toMatch(/update public\.memory_facts\s+set sensitivity = 'special_category'/);
    expect(sql).toMatch(/update public\.memory_items\s+set sensitivity = 'special_category'/);
  });

  it('the rule is immutable and runs with a fixed search_path', () => {
    expect(sql).toMatch(/memory_sensitivity_of\(p_text text\)\s+returns text\s+language sql\s+immutable\s+parallel safe\s+set search_path = pg_catalog/);
  });
});
