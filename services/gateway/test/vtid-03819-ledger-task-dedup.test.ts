/**
 * VTID-03819: Backlog-aware task intake — embedding dedup regression tests.
 *
 * checkForSimilarTask() gates task creation on an embedding similarity
 * search over vtid_ledger (find_similar_vtid_tasks RPC); stampTaskEmbedding()
 * populates the embedding column on newly-created rows so future checks can
 * find them. Both must fail OPEN (no match, never throw) when embeddings or
 * Supabase are unavailable — dedup is an availability enhancement, not a
 * precondition for task creation to work.
 */

jest.mock('node-fetch');
jest.mock('../src/services/embedding-service');

import fetch from 'node-fetch';
import { generateEmbedding } from '../src/services/embedding-service';
import {
  checkForSimilarTask,
  stampTaskEmbedding,
  HARD_DUPLICATE_THRESHOLD,
  RELATED_THRESHOLD,
} from '../src/services/ledger-task-dedup';

const mockedFetch = fetch as unknown as jest.Mock;
const mockedGenerateEmbedding = generateEmbedding as jest.Mock;

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as any;
}

const FAKE_EMBEDDING = new Array(1536).fill(0.01);

describe('checkForSimilarTask (VTID-03819)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    mockedFetch.mockReset();
    mockedGenerateEmbedding.mockReset();
    process.env = { ...ORIGINAL_ENV, SUPABASE_URL: 'http://localhost:54321', SUPABASE_SERVICE_ROLE: 'test-key' };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns {} when embedding generation fails (fail open)', async () => {
    mockedGenerateEmbedding.mockResolvedValue({ ok: false, error: 'no_api_key' });
    const result = await checkForSimilarTask('Fix webhook retry', 'Fix the Stripe webhook retry storm');
    expect(result).toEqual({});
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('returns {} when the RPC call fails', async () => {
    mockedGenerateEmbedding.mockResolvedValue({ ok: true, embedding: FAKE_EMBEDDING });
    mockedFetch.mockResolvedValue(jsonRes(500, { error: 'internal' }));
    const result = await checkForSimilarTask('Fix webhook retry', 'Fix the Stripe webhook retry storm');
    expect(result).toEqual({});
  });

  it('returns {} when the RPC call throws', async () => {
    mockedGenerateEmbedding.mockResolvedValue({ ok: true, embedding: FAKE_EMBEDDING });
    mockedFetch.mockRejectedValue(new Error('network down'));
    const result = await checkForSimilarTask('Fix webhook retry', 'Fix the Stripe webhook retry storm');
    expect(result).toEqual({});
  });

  it('returns {} when no matches are found', async () => {
    mockedGenerateEmbedding.mockResolvedValue({ ok: true, embedding: FAKE_EMBEDDING });
    mockedFetch.mockResolvedValue(jsonRes(200, []));
    const result = await checkForSimilarTask('Fix webhook retry', 'Fix the Stripe webhook retry storm');
    expect(result).toEqual({});
  });

  it('classifies a match at/above HARD_DUPLICATE_THRESHOLD as a duplicate', async () => {
    mockedGenerateEmbedding.mockResolvedValue({ ok: true, embedding: FAKE_EMBEDDING });
    mockedFetch.mockResolvedValue(jsonRes(200, [
      { vtid: 'VTID-04000', title: 'Fix Stripe webhook retry storm', status: 'in_progress', similarity: HARD_DUPLICATE_THRESHOLD },
    ]));
    const result = await checkForSimilarTask('Fix webhook retry', 'Fix the Stripe webhook retry storm');
    expect(result.duplicate).toEqual({ vtid: 'VTID-04000', title: 'Fix Stripe webhook retry storm', status: 'in_progress', similarity: HARD_DUPLICATE_THRESHOLD });
    expect(result.related).toBeUndefined();
  });

  it('classifies a match between RELATED_THRESHOLD and HARD_DUPLICATE_THRESHOLD as related, not duplicate', async () => {
    const midSimilarity = (RELATED_THRESHOLD + HARD_DUPLICATE_THRESHOLD) / 2;
    mockedGenerateEmbedding.mockResolvedValue({ ok: true, embedding: FAKE_EMBEDDING });
    mockedFetch.mockResolvedValue(jsonRes(200, [
      { vtid: 'VTID-04001', title: 'Investigate webhook retries', status: 'scheduled', similarity: midSimilarity },
    ]));
    const result = await checkForSimilarTask('Fix webhook retry', 'Fix the Stripe webhook retry storm');
    expect(result.related?.vtid).toBe('VTID-04001');
    expect(result.duplicate).toBeUndefined();
  });

  it('sends the RPC request against find_similar_vtid_tasks with the generated embedding', async () => {
    mockedGenerateEmbedding.mockResolvedValue({ ok: true, embedding: FAKE_EMBEDDING });
    mockedFetch.mockResolvedValue(jsonRes(200, []));
    await checkForSimilarTask('Fix webhook retry', 'Fix the Stripe webhook retry storm');

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toContain('/rest/v1/rpc/find_similar_vtid_tasks');
    const body = JSON.parse(init.body);
    expect(body.p_query_embedding).toBe(`[${FAKE_EMBEDDING.join(',')}]`);
    expect(body.p_min_similarity).toBe(RELATED_THRESHOLD);
  });
});

describe('stampTaskEmbedding (VTID-03819)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    mockedFetch.mockReset();
    mockedGenerateEmbedding.mockReset();
    process.env = { ...ORIGINAL_ENV, SUPABASE_URL: 'http://localhost:54321', SUPABASE_SERVICE_ROLE: 'test-key' };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('PATCHes the embedding column on the newly-created row', async () => {
    mockedGenerateEmbedding.mockResolvedValue({ ok: true, embedding: FAKE_EMBEDDING });
    mockedFetch.mockResolvedValue(jsonRes(204, null));

    await stampTaskEmbedding('VTID-04002', 'Fix webhook retry', 'Fix the Stripe webhook retry storm');

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toContain('/rest/v1/vtid_ledger?vtid=eq.VTID-04002');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body);
    expect(body.embedding).toBe(`[${FAKE_EMBEDDING.join(',')}]`);
    expect(typeof body.embedding_updated_at).toBe('string');
  });

  it('never throws when embedding generation fails', async () => {
    mockedGenerateEmbedding.mockResolvedValue({ ok: false, error: 'no_api_key' });
    await expect(stampTaskEmbedding('VTID-04003', 'title', 'desc')).resolves.toBeUndefined();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('never throws when the PATCH request fails', async () => {
    mockedGenerateEmbedding.mockResolvedValue({ ok: true, embedding: FAKE_EMBEDDING });
    mockedFetch.mockResolvedValue(jsonRes(500, { error: 'internal' }));
    await expect(stampTaskEmbedding('VTID-04004', 'title', 'desc')).resolves.toBeUndefined();
  });

  it('never throws when fetch itself throws', async () => {
    mockedGenerateEmbedding.mockResolvedValue({ ok: true, embedding: FAKE_EMBEDDING });
    mockedFetch.mockRejectedValue(new Error('network down'));
    await expect(stampTaskEmbedding('VTID-04005', 'title', 'desc')).resolves.toBeUndefined();
  });

});

describe('Supabase-not-configured guard (VTID-03819, source check)', () => {
  // SUPABASE_URL/SUPABASE_SERVICE_ROLE are read into module-level consts at
  // import time (matching operator-service.ts's own pattern), so toggling
  // process.env after the module is already loaded/mocked in this file has
  // no effect on those consts, and re-requiring the module inside an
  // isolated registry risks mutating the shared auto-mocked
  // embedding-service module other tests in this file depend on. A
  // source-level check is the reliable way to pin this guard clause,
  // consistent with this codebase's established pattern for
  // hard-to-isolate early-return branches (see
  // vtid-03818-reaper-terminal-flag.test.ts).
  const fs = require('fs');
  const path = require('path');
  const SOURCE = fs.readFileSync(
    path.join(__dirname, '../src/services/ledger-task-dedup.ts'),
    'utf8'
  );

  it('checkForSimilarTask returns {} before generating an embedding when Supabase is unconfigured', () => {
    const start = SOURCE.indexOf('export async function checkForSimilarTask');
    const generateCallIdx = SOURCE.indexOf('generateEmbedding(text)', start);
    const guardIdx = SOURCE.indexOf('if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE)', start);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(generateCallIdx);
    const guardBlock = SOURCE.slice(guardIdx, guardIdx + 150);
    expect(guardBlock).toMatch(/return\s*\{\};/);
  });

  it('stampTaskEmbedding returns before generating an embedding when Supabase is unconfigured', () => {
    const start = SOURCE.indexOf('export async function stampTaskEmbedding');
    const generateCallIdx = SOURCE.indexOf('generateEmbedding(text)', start);
    const guardIdx = SOURCE.indexOf('if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return;', start);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(generateCallIdx);
  });
});
