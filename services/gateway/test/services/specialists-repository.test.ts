import * as repo from '../../src/services/specialists/specialists-repository';
import { RepositoryError, __setClientForTest } from '../../src/services/specialists/specialists-repository';

// VTID-03498 (Aurora migration B1) — data-access seam for the specialists domain.
//
// The point of these tests is the CONTRACT, not the SQL. When the adapter is
// swapped to Aurora, this file should keep passing unchanged — that is what
// makes it a seam rather than a rename.
//
// The behaviour worth pinning hardest is the error contract. The old route code
// destructured `{ data }` and dropped `error` on several reads, so a failed
// query was indistinguishable from an empty table — the same silent-failure
// shape as VTID-03480. The repository must now surface that.

type Result = { data: unknown; error: { message: string } | null };

/**
 * Minimal chainable stub of the supabase query builder. Every terminal method
 * resolves to the single configured result; every intermediate returns `this`.
 */
function makeClient(result: Result, spy?: { calls: string[] }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of ['select', 'eq', 'order', 'limit', 'insert', 'update', 'delete']) {
    builder[m] = (...args: unknown[]) => {
      spy?.calls.push(`${m}(${args.length ? JSON.stringify(args[0]) : ''})`);
      return chain();
    };
  }
  // Terminal awaits
  builder.maybeSingle = () => Promise.resolve(result);
  builder.single = () => Promise.resolve(result);
  builder.then = (res: (r: Result) => unknown) => Promise.resolve(result).then(res);
  return {
    from: (t: string) => {
      spy?.calls.push(`from(${t})`);
      return builder;
    },
    rpc: (fn: string, params: unknown) => {
      spy?.calls.push(`rpc(${fn},${JSON.stringify(params)})`);
      return Promise.resolve(result);
    },
  } as never;
}

afterEach(() => __setClientForTest(null));

describe('reads — success', () => {
  it('listPersonas returns rows', async () => {
    __setClientForTest(makeClient({ data: [{ id: 'p1', key: 'vitana', version: 3 }], error: null }));
    const rows = await repo.listPersonas();
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('vitana');
  });

  it('listPersonas returns [] rather than null on an empty table', async () => {
    __setClientForTest(makeClient({ data: null, error: null }));
    await expect(repo.listPersonas()).resolves.toEqual([]);
  });

  it('getPersonaByKey returns null when the persona is genuinely absent', async () => {
    __setClientForTest(makeClient({ data: null, error: null }));
    await expect(repo.getPersonaByKey('nope')).resolves.toBeNull();
  });
});

describe('reads — errors surface instead of looking empty', () => {
  it('listPersonas throws RepositoryError on a query error', async () => {
    __setClientForTest(makeClient({ data: null, error: { message: 'connection reset' } }));
    await expect(repo.listPersonas()).rejects.toBeInstanceOf(RepositoryError);
  });

  it('carries the underlying message and the operation name', async () => {
    __setClientForTest(makeClient({ data: null, error: { message: 'connection reset' } }));
    await expect(repo.listPersonas()).rejects.toMatchObject({
      message: 'connection reset',
      operation: 'listPersonas',
    });
  });

  it('distinguishes a failed lookup from an absent row', async () => {
    // Both used to return null to the caller. Only the second is healthy.
    __setClientForTest(makeClient({ data: null, error: { message: 'boom' } }));
    await expect(repo.getPersonaByKey('vitana')).rejects.toBeInstanceOf(RepositoryError);

    __setClientForTest(makeClient({ data: null, error: null }));
    await expect(repo.getPersonaByKey('vitana')).resolves.toBeNull();
  });

  it('throws on a failed binding read', async () => {
    __setClientForTest(makeClient({ data: null, error: { message: 'nope' } }));
    await expect(repo.listToolBindings('p1')).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('writes', () => {
  it('createPersona returns the inserted row', async () => {
    __setClientForTest(makeClient({ data: { id: 'p9', key: 'coach', version: 1 }, error: null }));
    await expect(repo.createPersona({ key: 'coach' })).resolves.toMatchObject({ id: 'p9' });
  });

  it('createPersona throws when the insert fails', async () => {
    __setClientForTest(makeClient({ data: null, error: { message: 'duplicate key' } }));
    await expect(repo.createPersona({ key: 'coach' })).rejects.toBeInstanceOf(RepositoryError);
  });

  it('updatePersona throws when the row cannot be written', async () => {
    __setClientForTest(makeClient({ data: null, error: { message: 'permission denied' } }));
    await expect(repo.updatePersona('p1', { status: 'active' })).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('replaceToolBindings', () => {
  it('deletes then inserts when keys are supplied', async () => {
    const spy = { calls: [] as string[] };
    __setClientForTest(makeClient({ data: null, error: null }, spy));
    await repo.replaceToolBindings('p1', ['a', 'b'], 'user-1');
    expect(spy.calls.some((c) => c.startsWith('delete'))).toBe(true);
    expect(spy.calls.some((c) => c.startsWith('insert'))).toBe(true);
  });

  it('skips the insert entirely when the key list is empty', async () => {
    const spy = { calls: [] as string[] };
    __setClientForTest(makeClient({ data: null, error: null }, spy));
    await repo.replaceToolBindings('p1', [], 'user-1');
    expect(spy.calls.some((c) => c.startsWith('delete'))).toBe(true);
    expect(spy.calls.some((c) => c.startsWith('insert'))).toBe(false);
  });

  it('throws if the delete half fails, rather than silently clearing nothing', async () => {
    __setClientForTest(makeClient({ data: null, error: { message: 'delete failed' } }));
    await expect(repo.replaceToolBindings('p1', ['a'], 'u1')).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('audit is best-effort by design', () => {
  it('does not throw when the audit insert fails', async () => {
    // An audit failure must not fail the operator's mutation. Previously this
    // was an accident of dropping the result; now it is deliberate and logged.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    __setClientForTest(makeClient({ data: null, error: { message: 'audit table gone' } }));
    await expect(repo.writeAudit('u1', 'p1', 'persona_edit', null, null)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('listAuditLog, unlike writeAudit, does throw — a failed read must not read as "no activity"', async () => {
    __setClientForTest(makeClient({ data: null, error: { message: 'boom' } }));
    await expect(repo.listAuditLog(100)).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('rpc', () => {
  it('buildSpecialistContext returns the payload', async () => {
    __setClientForTest(makeClient({ data: { pillars: [] }, error: null }));
    await expect(repo.buildSpecialistContext('u1')).resolves.toEqual({ pillars: [] });
  });

  it('buildSpecialistContext throws on rpc error', async () => {
    __setClientForTest(makeClient({ data: null, error: { message: 'no such function' } }));
    await expect(repo.buildSpecialistContext('u1')).rejects.toBeInstanceOf(RepositoryError);
  });
});
