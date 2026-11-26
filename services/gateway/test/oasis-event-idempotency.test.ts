/**
 * Delivery loop, durable event recording: emitOasisEvent with an `idempotency_key`.
 *
 * The same fact written twice (two gateway tasks, a webhook retry that lands on another task, a re-run) must be one row in
 * oasis_events, without a new table or a migration. The row id is derived from (env, topic, key); oasis_events.id is the
 * primary key, so `Prefer: resolution=ignore-duplicates` (ON CONFLICT DO NOTHING) leaves the first row and PostgREST answers
 * an empty array for the second. An event without a key is written exactly as before.
 *
 * Only the network is faked (the global fetch of setup-tests.ts), and the fake models what PostgREST does for the primary
 * key: it is not a PostgREST. See docs/validation/delivery-loop/slice-3-durable-events/acceptance.md for what is and is not
 * proven by it.
 */
jest.mock('../src/services/timeline-projector', () => ({ projectOasisEventToTimeline: jest.fn(async () => undefined) }));

import { emitOasisEvent, idempotentEventId } from '../src/services/oasis-event-service';
import { projectOasisEventToTimeline } from '../src/services/timeline-projector';
import type { CicdOasisEvent } from '../src/types/cicd';

const fetchMock = global.fetch as unknown as jest.Mock;
const projector = projectOasisEventToTimeline as jest.Mock;

type Insert = { url: string; headers: Record<string, string>; body: Record<string, any> };
let inserts: Insert[];
/** The rows of the fake table, by primary key. */
let table: Map<string, Record<string, any>>;
let respond: (insert: Insert) => { ok: boolean; status: number; json?: () => Promise<unknown>; text?: () => Promise<string> };

const UUID_V5_LAYOUT = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const event = (over: Partial<CicdOasisEvent> = {}): CicdOasisEvent => ({
  vtid: 'BOOTSTRAP-DELIVERY',
  type: 'delivery.intake.accepted',
  source: 'delivery-loop',
  status: 'info',
  message: 'task accepted',
  payload: { issue_iid: 17 },
  env: 'staging',
  ...over,
});

/** What PostgREST does for POST /oasis_events: a new id inserts and returns the row; a known id is skipped (ignore-duplicates) or a 409. */
function postgrestForPrimaryKey(insert: Insert) {
  if (table.has(insert.body.id)) {
    if (/resolution=ignore-duplicates/.test(insert.headers.Prefer)) return { ok: true, status: 201, json: async () => [] as unknown[], text: async () => '[]' };
    return { ok: false, status: 409, text: async () => 'duplicate key value violates unique constraint "oasis_events_pkey"' };
  }
  table.set(insert.body.id, insert.body);
  return { ok: true, status: 201, json: async () => [insert.body], text: async () => JSON.stringify([insert.body]) };
}

beforeEach(() => {
  inserts = [];
  table = new Map();
  respond = postgrestForPrimaryKey;
  projector.mockClear();
  fetchMock.mockImplementation(async (url: string, init: any = {}) => {
    if (!String(url).includes('/rest/v1/oasis_events')) throw new Error(`unexpected fetch ${url}`);
    const insert = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    inserts.push(insert);
    return respond(insert);
  });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('idempotentEventId', () => {
  it('is a version 5 layout UUID that Postgres uuid accepts', () => {
    expect(idempotentEventId('staging', 'delivery.intake.accepted', 'intake:vitana/vitana-platform:17')).toMatch(UUID_V5_LAYOUT);
  });

  it('is the same for the same (env, topic, key) and different when any of the three differs', () => {
    const base = idempotentEventId('staging', 'a.b', 'k');
    expect(idempotentEventId('staging', 'a.b', 'k')).toBe(base);
    expect(new Set([base, idempotentEventId('production', 'a.b', 'k'), idempotentEventId('staging', 'a.c', 'k'), idempotentEventId('staging', 'a.b', 'k2')]).size).toBe(4);
  });

  it('does not let one field run into the next: ("ab","c") and ("a","bc") are different', () => {
    expect(idempotentEventId('staging', 'ab', 'c')).not.toBe(idempotentEventId('staging', 'a', 'bc'));
  });

  it('is pinned: changing the derivation would make a rolling deploy write the same fact twice', () => {
    expect(idempotentEventId('staging', 'scm.gitlab.pipeline.failed', 'gitlab:vitana/vitana-platform:pipeline:31:failed')).toBe('5add029a-0711-5bd3-a33a-358dbfc766f6');
  });
});

describe('emitOasisEvent without an idempotency key is unchanged', () => {
  it('writes a random row id and Prefer exactly return=representation, and never reads the response body', async () => {
    const json = jest.fn(async () => {
      throw new Error('the unkeyed path must not read the body');
    });
    respond = () => ({ ok: true, status: 201, json });
    const first = await emitOasisEvent(event());
    const second = await emitOasisEvent(event());
    expect(inserts).toHaveLength(2);
    expect(inserts[0].headers.Prefer).toBe('return=representation');
    expect(inserts[0].body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserts[0].body.id).not.toBe(inserts[1].body.id);
    expect(first).toEqual({ ok: true, event_id: inserts[0].body.id });
    expect(second).toEqual({ ok: true, event_id: inserts[1].body.id });
    expect(json).not.toHaveBeenCalled();
    expect(projector).toHaveBeenCalledTimes(2);
  });

  it('an empty idempotency_key is treated as no key', async () => {
    await emitOasisEvent(event({ idempotency_key: '' }));
    expect(inserts[0].headers.Prefer).toBe('return=representation');
  });
});

describe('emitOasisEvent with an idempotency key', () => {
  it('writes the deterministic id and asks for ignore-duplicates, keeping return=representation', async () => {
    const result = await emitOasisEvent(event({ idempotency_key: 'intake:17' }));
    const id = idempotentEventId('staging', 'delivery.intake.accepted', 'intake:17');
    expect(inserts[0].body.id).toBe(id);
    expect(inserts[0].headers.Prefer).toBe('return=representation,resolution=ignore-duplicates');
    expect(result).toEqual({ ok: true, event_id: id });
    expect(projector).toHaveBeenCalledTimes(1);
  });

  it('the env is part of the scope: the same key is a different row on staging and on production', async () => {
    await emitOasisEvent(event({ idempotency_key: 'intake:17', env: 'staging' }));
    await emitOasisEvent(event({ idempotency_key: 'intake:17', env: 'production' }));
    expect(table.size).toBe(2);
  });

  it('the second write of the same fact adds no row, answers ok with duplicate, and does not project to the timeline again', async () => {
    const first = await emitOasisEvent(event({ idempotency_key: 'intake:17' }));
    const second = await emitOasisEvent(event({ idempotency_key: 'intake:17', payload: { issue_iid: 17, retried: true } }));
    expect(inserts).toHaveLength(2);
    expect(table.size).toBe(1);
    expect(first.duplicate).toBeUndefined();
    expect(second).toEqual({ ok: true, event_id: first.event_id, duplicate: true });
    expect(projector).toHaveBeenCalledTimes(1);
  });

  it('a different topic with the same key is a different fact', async () => {
    await emitOasisEvent(event({ idempotency_key: 'k' }));
    const other = await emitOasisEvent(event({ idempotency_key: 'k', type: 'delivery.intake.rejected' }));
    expect(other.duplicate).toBeUndefined();
    expect(table.size).toBe(2);
  });

  it('a response that is not an empty JSON array is treated as a new row (the behaviour before the key existed)', async () => {
    for (const reply of [
      { ok: true, status: 201, json: async () => ({}) },
      { ok: true, status: 201, json: async () => null },
      { ok: true, status: 201, json: async () => { throw new Error('not json'); } },
      { ok: true, status: 201 },
    ]) {
      respond = () => reply;
      const r = await emitOasisEvent(event({ idempotency_key: `k-${inserts.length}` }));
      expect(r.ok).toBe(true);
      expect(r.duplicate).toBeUndefined();
    }
    expect(projector).toHaveBeenCalledTimes(4);
  });

  it('a failed write is a failure, not a duplicate, and is not projected', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    respond = () => ({ ok: false, status: 503, text: async () => 'upstream unavailable' });
    expect(await emitOasisEvent(event({ idempotency_key: 'k' }))).toEqual({ ok: false, error: 'Failed to emit event: 503' });
    expect(projector).not.toHaveBeenCalled();
  });

  it('a network error is a failure', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async () => {
      throw new Error('socket hang up');
    });
    expect(await emitOasisEvent(event({ idempotency_key: 'k' }))).toEqual({ ok: false, error: 'socket hang up' });
  });

  it('the NOT NULL guard still applies: an event without a message is not sent, key or no key', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await emitOasisEvent({ ...event({ idempotency_key: 'k' }), message: undefined } as unknown as CicdOasisEvent);
    expect(r).toEqual({ ok: false, error: 'missing_required_fields:message' });
    expect(inserts).toHaveLength(0);
  });

  it('twenty concurrent writes of one fact leave one row', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => emitOasisEvent(event({ idempotency_key: 'burst' }))));
    expect(table.size).toBe(1);
    expect(results.filter((r) => r.duplicate === true)).toHaveLength(19);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
