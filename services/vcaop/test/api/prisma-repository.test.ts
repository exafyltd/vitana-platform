import { PrismaRepository, writeWithEvent, PrismaLike, COLLECTION_TO_MODEL } from '../../src/api/prisma-repository';
import { REDACTION } from '../../src/guardrails/no-pii-leak';

/**
 * Fake PrismaClient: buffers writes inside $transaction and only commits to the
 * backing store when the callback resolves; discards on throw (atomic rollback).
 * A shared `fails` set lets a test force a given model's create to throw — in BOTH
 * the top-level client and the tx delegates (they share the closure).
 */
function makeFakePrisma() {
  const store: Record<string, Map<string, any>> = {};
  const fails = new Set<string>();
  const ensure = (m: string) => (store[m] ??= new Map());
  function delegateFor(model: string, target: Record<string, Map<string, any>>) {
    return {
      async create({ data }: any) {
        if (fails.has(model)) throw new Error('boom');
        (target[model] ??= new Map()).set(data.id, data);
        return data;
      },
      async findUnique({ where }: any) { return ensure(model).get(where.id) ?? null; },
      async findMany() { return [...ensure(model).values()]; },
      async update({ where, data }: any) { const cur = ensure(model).get(where.id) ?? { id: where.id }; const next = { ...cur, ...data }; ensure(model).set(where.id, next); return next; },
    };
  }
  const client: any = {
    async $transaction(fn: (tx: PrismaLike) => Promise<any>) {
      const buffer: Record<string, Map<string, any>> = {};
      const tx: any = {};
      for (const model of Object.values(COLLECTION_TO_MODEL)) tx[model] = delegateFor(model, buffer);
      const result = await fn(tx); // throws ⇒ buffer discarded (rollback)
      for (const [m, map] of Object.entries(buffer)) for (const [id, v] of map) ensure(m).set(id, v);
      return result;
    },
  };
  for (const model of Object.values(COLLECTION_TO_MODEL)) client[model] = delegateFor(model, store);
  return { client: client as PrismaLike, store, ensure, fails };
}

const evt = { type: 'vcaop.provider_account.created', source: 'test', status: 'success' as const, message: 'x', payload: { providerId: 'amazon' } };

describe('PrismaRepository + writeWithEvent (same-tx OASIS)', () => {
  test('basic CRUD via delegates', async () => {
    const { client } = makeFakePrisma();
    const repo = new PrismaRepository(client);
    const a = await repo.create('provider', { id: 'amazon', name: 'Amazon' });
    expect(a.id).toBe('amazon');
    expect(await repo.get('provider', 'amazon')).toMatchObject({ name: 'Amazon' });
    await repo.update('provider', 'amazon', { category: 'marketplace' });
    expect((await repo.get('provider', 'amazon'))!.category).toBe('marketplace');
    expect(await repo.list('provider')).toHaveLength(1);
  });

  test('writeWithEvent commits BOTH the row and the OASIS event in one tx', async () => {
    const { client, ensure } = makeFakePrisma();
    await writeWithEvent(client, {
      collection: 'provider_account',
      record: { id: 'acc1', tenant_id: 'platform', provider_id: 'amazon', status: 'discovered' },
      event: evt,
    });
    expect(ensure('providerAccount').size).toBe(1);
    expect(ensure('oasisEvent').size).toBe(1); // event written in the same tx
  });

  test('if the event insert fails, the row is rolled back too (atomic)', async () => {
    const { client, ensure, fails } = makeFakePrisma();
    fails.add('oasisEvent'); // force the same-tx event insert to throw
    await expect(
      writeWithEvent(client, { collection: 'provider_account', record: { id: 'acc2', tenant_id: 'platform', provider_id: 'amazon', status: 'discovered' }, event: evt }),
    ).rejects.toThrow('boom');
    expect(ensure('providerAccount').size).toBe(0); // rolled back — no row without its event
    expect(ensure('oasisEvent').size).toBe(0);
  });

  test('PII in the event payload is redacted (not leaked) before it is stored', async () => {
    const { client, ensure } = makeFakePrisma();
    await writeWithEvent(client, {
      collection: 'provider_account',
      record: { id: 'acc3', tenant_id: 'platform', provider_id: 'amazon', status: 'discovered' },
      event: { ...evt, payload: { email: 'leak@x.com', providerId: 'amazon' } },
    });
    const storedEvent = [...ensure('oasisEvent').values()][0];
    expect(JSON.stringify(storedEvent)).not.toMatch(/leak@x\.com/);
    expect(storedEvent.metadata.email).toBe(REDACTION);
  });
});
