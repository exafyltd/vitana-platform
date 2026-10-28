/**
 * VTID-05006: dev_create_pr / dev_merge_pr reach the CICD routes with the
 * field names those routes validate. Kiro's write tools run these executors,
 * so a name mismatch would reject every PR (create) or silently squash
 * (merge). Each body the executor sends is parsed with the route's own schema.
 */
jest.mock('node-fetch');
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => ({ ok: true })),
  recommendationSyncEvents: {},
}));

import fetch from 'node-fetch';
import { executeTool } from '../src/services/gemini-operator';
import { CreatePrRequestSchema, SafeMergeRequestSchema } from '../src/types/cicd';

const fetchMock = fetch as unknown as jest.Mock;

function lastBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return JSON.parse(call[1].body);
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, pr_number: 7, pr_url: 'https://x/7' }) });
});

describe('VTID-05006 dev PR executors match the CICD route schemas', () => {
  it('dev_create_pr sends head/base that CreatePrRequestSchema accepts', async () => {
    await executeTool('dev_create_pr', { vtid: 'VTID-05006', head_branch: 'kiro/abcd1234/readme-fix' }, 't-1');
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/v1\/github\/create-pr$/);
    const parsed = CreatePrRequestSchema.safeParse(lastBody());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.head).toBe('kiro/abcd1234/readme-fix');
      expect(parsed.data.base).toBe('main');
    }
  });

  it('dev_merge_pr forwards the chosen method as merge_strategy', async () => {
    for (const method of ['merge', 'rebase', 'squash'] as const) {
      await executeTool('dev_merge_pr', { vtid: 'VTID-05006', pr_number: 7, merge_method: method }, 't-1');
      const parsed = SafeMergeRequestSchema.safeParse(lastBody());
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.merge_strategy).toBe(method);
    }
  });

  it('dev_merge_pr defaults to squash when no method is given', async () => {
    await executeTool('dev_merge_pr', { vtid: 'VTID-05006', pr_number: 7 }, 't-1');
    const parsed = SafeMergeRequestSchema.safeParse(lastBody());
    expect(parsed.success && parsed.data.merge_strategy).toBe('squash');
  });
});
