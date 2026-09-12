/**
 * VTID-03819: createOperatorTask() dedup-wiring regression tests.
 *
 * The dedup check (checkForSimilarTask) runs BEFORE allocateVtid — a
 * duplicate must short-circuit without ever minting a new VTID number or
 * writing a ledger row. A related (non-duplicate) match must still create
 * the task normally, but stamp metadata.related_vtid, and the new row's
 * embedding must be stamped afterward for future dedup checks.
 */

jest.mock('node-fetch');
jest.mock('../src/services/ledger-task-dedup');

import fetch from 'node-fetch';
import { createOperatorTask } from '../src/services/operator-service';
import { checkForSimilarTask, stampTaskEmbedding } from '../src/services/ledger-task-dedup';

const mockedFetch = fetch as unknown as jest.Mock;
const mockedCheckForSimilarTask = checkForSimilarTask as jest.Mock;
const mockedStampTaskEmbedding = stampTaskEmbedding as jest.Mock;

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as any;
}

describe('createOperatorTask dedup wiring (VTID-03819)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    mockedFetch.mockReset();
    mockedCheckForSimilarTask.mockReset();
    mockedStampTaskEmbedding.mockReset().mockResolvedValue(undefined);
    process.env = { ...ORIGINAL_ENV, SUPABASE_URL: 'http://localhost:54321', SUPABASE_SERVICE_ROLE: 'test-key' };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('short-circuits on a duplicate: returns the existing VTID and never calls the allocator', async () => {
    mockedCheckForSimilarTask.mockResolvedValue({
      duplicate: { vtid: 'VTID-04010', title: 'Existing task', status: 'in_progress', similarity: 0.97 },
    });

    const result = await createOperatorTask({
      rawDescription: 'DEV: existing task, please redo',
      sourceThreadId: 'thread-1',
    });

    expect(result).toEqual({
      vtid: 'VTID-04010',
      title: 'Existing task',
      mode: 'plan-only',
      duplicate: true,
    });
    // No allocator RPC, no ledger PATCH, no spec event — nothing was created.
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(mockedStampTaskEmbedding).not.toHaveBeenCalled();
  });

  it('creates normally when no similar task is found, and stamps the new row embedding', async () => {
    mockedCheckForSimilarTask.mockResolvedValue({});
    mockedFetch.mockImplementation((url: string) => {
      if (url.includes('allocate_global_vtid')) {
        return Promise.resolve(jsonRes(200, [{ vtid: 'VTID-04011', num: 4011, id: 'row-1' }]));
      }
      if (url.includes('/rest/v1/vtid_ledger')) {
        return Promise.resolve(jsonRes(200, [{ vtid: 'VTID-04011' }]));
      }
      if (url.includes('/rest/v1/oasis_events')) {
        return Promise.resolve(jsonRes(200, null));
      }
      return Promise.resolve(jsonRes(404, { error: 'unexpected url' }));
    });

    const result = await createOperatorTask({
      rawDescription: 'DEV: a brand new task nobody has filed before',
      sourceThreadId: 'thread-2',
    });

    expect(result?.vtid).toBe('VTID-04011');
    expect(result?.duplicate).toBeUndefined();
    expect(mockedStampTaskEmbedding).toHaveBeenCalledWith(
      'VTID-04011',
      expect.any(String),
      'DEV: a brand new task nobody has filed before'
    );
  });

  it('creates normally on a related (non-duplicate) match, and stamps related_vtid in metadata', async () => {
    mockedCheckForSimilarTask.mockResolvedValue({
      related: { vtid: 'VTID-04012', title: 'Something similar', status: 'scheduled', similarity: 0.85 },
    });

    let ledgerPatchBody: any = null;
    mockedFetch.mockImplementation((url: string, init?: any) => {
      if (url.includes('allocate_global_vtid')) {
        return Promise.resolve(jsonRes(200, [{ vtid: 'VTID-04013', num: 4013, id: 'row-2' }]));
      }
      if (url.includes('/rest/v1/vtid_ledger')) {
        ledgerPatchBody = JSON.parse(init.body);
        return Promise.resolve(jsonRes(200, [{ vtid: 'VTID-04013' }]));
      }
      if (url.includes('/rest/v1/oasis_events')) {
        return Promise.resolve(jsonRes(200, null));
      }
      return Promise.resolve(jsonRes(404, { error: 'unexpected url' }));
    });

    const result = await createOperatorTask({
      rawDescription: 'DEV: a task related to an existing one',
      sourceThreadId: 'thread-3',
    });

    expect(result?.vtid).toBe('VTID-04013');
    expect(result?.duplicate).toBeUndefined();
    expect(ledgerPatchBody?.metadata?.related_vtid).toBe('VTID-04012');
    expect(ledgerPatchBody?.metadata?.related_similarity).toBe(0.85);
  });
});
