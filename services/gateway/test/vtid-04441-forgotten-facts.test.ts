/**
 * VTID-04441 — a fact the user forgot in the Memory Garden is not re-learned.
 *
 * Pins: forgetting records one hashed marker per value (the value itself is
 * never stored); an inferred write of a forgotten value is refused before any
 * RPC; a different value for the same key is still learned; an explicit user
 * statement is written and clears the marker; a marker store that fails lets
 * the write through; and the Garden delete still happens when marking fails.
 */
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../src/services/memory-embedding', () => ({
  embedMemoryText: jest.fn(async () => ({ ok: false, error: 'off' })),
  toPgVector: (e: number[]) => `[${e.join(',')}]`,
}));

import { rememberFact } from '../src/services/memory/remember';
import {
  checkForgottenGate,
  hashFactValue,
  isExplicitUserStatement,
  normalizeFactValue,
  type ForgottenStore,
} from '../src/services/memory/forgotten';
import { deleteGardenEntry } from '../src/services/memory/garden';

const KEY = { tenant_id: 't1', user_id: 'u1', fact_key: 'favorite_food' };

function memoryStore(): ForgottenStore & { rows: Set<string> } {
  const rows = new Set<string>();
  const id = (k: typeof KEY, h: string) => `${k.tenant_id}|${k.user_id}|${k.fact_key}|${h}`;
  return {
    rows,
    async has(k, h) { return rows.has(id(k, h)); },
    async add(k, hs) { for (const h of hs) rows.add(id(k, h)); },
    async clear(k, h) { rows.delete(id(k, h)); },
  };
}

const inferred = {
  ...KEY,
  fact_value: 'Pasta',
  provenance_source: 'assistant_inferred',
  provenance_confidence: 0.8,
  actor: 'inline-fact-extractor',
};

describe('forgotten helpers', () => {
  it('normalises case and whitespace before hashing, and never returns the value', () => {
    expect(normalizeFactValue('  Pasta   Carbonara ')).toBe('pasta carbonara');
    expect(hashFactValue('Pasta  Carbonara')).toBe(hashFactValue(' pasta carbonara'));
    expect(hashFactValue('pasta')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFactValue('pasta')).not.toContain('pasta');
  });

  it.each([
    ['user_stated', true],
    ['user_stated_via_memory_garden_ui', true],
    ['user_stated_via_settings', true],
    ['user_edited', true],
    ['assistant_inferred', false],
    ['behavior_inferred', false],
    ['system_observed', false],
    ['user_statedX', false],
    ['', false],
  ])('%s is an explicit user statement: %s', (p, expected) => {
    expect(isExplicitUserStatement(p)).toBe(expected);
  });
});

describe('rememberFact with a forgotten marker', () => {
  it('refuses an inferred write of a forgotten value before any RPC', async () => {
    const store = memoryStore();
    await store.add(KEY, [hashFactValue('pasta')]);
    const client = { rpc: jest.fn() };
    const r = await rememberFact(inferred, { client: client as any, forgottenStore: store, embed: false });
    expect(r).toMatchObject({ ok: false, blocked: 'forgotten' });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('still learns a different value for the same key', async () => {
    const store = memoryStore();
    await store.add(KEY, [hashFactValue('pasta')]);
    const client = { rpc: jest.fn().mockResolvedValue({ data: 'f-new', error: null }) };
    const r = await rememberFact({ ...inferred, fact_value: 'sushi' }, { client: client as any, forgottenStore: store, embed: false });
    expect(r).toEqual({ ok: true, fact_id: 'f-new' });
  });

  it('writes an explicit user statement and clears the marker', async () => {
    const store = memoryStore();
    await store.add(KEY, [hashFactValue('pasta')]);
    const client = { rpc: jest.fn().mockResolvedValue({ data: 'f-told', error: null }) };
    const r = await rememberFact(
      { ...inferred, provenance_source: 'user_stated', provenance_confidence: 1 },
      { client: client as any, forgottenStore: store, embed: false },
    );
    expect(r).toEqual({ ok: true, fact_id: 'f-told' });
    expect(store.rows.size).toBe(0);
    // Once told again, inference may reinforce it.
    const again = await rememberFact(inferred, { client: client as any, forgottenStore: store, embed: false });
    expect(again.ok).toBe(true);
  });

  it('lets the write through when the marker store fails (logged, never blocks memory)', async () => {
    const broken: ForgottenStore = {
      has: async () => { throw new Error('relation does not exist'); },
      add: async () => {},
      clear: async () => {},
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const client = { rpc: jest.fn().mockResolvedValue({ data: 'f-1', error: null }) };
    const r = await rememberFact(inferred, { client: client as any, forgottenStore: broken, embed: false });
    expect(r.ok).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[VTID-04441]'));
    warn.mockRestore();
  });

  it('checkForgottenGate with no store allows', async () => {
    expect(await checkForgottenGate(null, KEY, 'pasta', 'assistant_inferred')).toEqual({ allow: true });
  });
});

describe('Garden forget records markers', () => {
  function client(opts: { upsertError?: string } = {}) {
    const log: any[] = [];
    const client: any = {
      log,
      from(table: string) {
        const calls: any[] = [];
        log.push({ table, calls });
        const b: any = {};
        for (const m of ['select', 'eq', 'is', 'limit', 'delete', 'maybeSingle']) {
          b[m] = (...args: any[]) => { calls.push({ m, args }); return b; };
        }
        b.upsert = (rows: any, o: any) => { calls.push({ m: 'upsert', args: [rows, o] }); return b; };
        b.then = (res: any) => {
          let r: any = { data: null, error: null };
          if (table === 'memory_facts') {
            if (calls.some((c) => c.m === 'maybeSingle')) r = { data: { fact_key: 'favorite_food' }, error: null };
            else if (calls.some((c) => c.m === 'delete')) r = { data: null, error: null };
            else r = { data: [{ fact_value: 'Pasta' }, { fact_value: 'pasta ' }, { fact_value: 'Lasagne' }], error: null };
          }
          if (table === 'memory_fact_forgotten' && opts.upsertError) r = { data: null, error: { message: opts.upsertError } };
          return Promise.resolve(r).then(res);
        };
        return b;
      },
    };
    return client;
  }

  it('writes one hashed marker per distinct value, then deletes the key', async () => {
    const c = client();
    const r = await deleteGardenEntry(c, { tenant_id: 't1', user_id: 'u1' }, 'fact', 'f1');
    expect(r).toEqual({ ok: true, id: 'f1' });
    const mark = c.log.find((l: any) => l.table === 'memory_fact_forgotten');
    const [rows] = mark.calls.find((x: any) => x.m === 'upsert').args;
    expect(rows).toEqual([
      { tenant_id: 't1', user_id: 'u1', fact_key: 'favorite_food', value_hash: hashFactValue('pasta') },
      { tenant_id: 't1', user_id: 'u1', fact_key: 'favorite_food', value_hash: hashFactValue('lasagne') },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/pasta|lasagne/i);
    const order = c.log.map((l: any) => l.table);
    expect(order.indexOf('memory_fact_forgotten')).toBeLessThan(order.lastIndexOf('memory_facts'));
    expect(c.log[c.log.length - 1].calls.some((x: any) => x.m === 'delete')).toBe(true);
  });

  it('still forgets the fact when the marker write fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const c = client({ upsertError: 'boom' });
    const r = await deleteGardenEntry(c, { tenant_id: 't1', user_id: 'u1' }, 'fact', 'f1');
    expect(r).toEqual({ ok: true, id: 'f1' });
    expect(c.log[c.log.length - 1].calls.some((x: any) => x.m === 'delete')).toBe(true);
    warn.mockRestore();
  });
});
