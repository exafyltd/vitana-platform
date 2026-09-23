/**
 * VTID-04364: rememberFact() is the single write path for memory facts.
 *
 * Pins: the Identity Lock refuses an inferred write to an identity-class key
 * before any RPC; the REST and client transports send the same payload; a
 * failed RPC is reported, never thrown; an empty value is refused; and every
 * former direct caller of the write_fact RPC now goes through this module.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockEmit = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...a: any[]) => mockEmit(...a),
}));

import { rememberFact, buildWriteFactPayload } from '../../../src/services/memory/remember';

const base = {
  tenant_id: 't1',
  user_id: 'u1',
  fact_key: 'favorite_food',
  fact_value: 'pasta',
  provenance_source: 'assistant_inferred',
  provenance_confidence: 0.8,
  actor: 'test',
};

const mockFetch = jest.fn();
beforeEach(() => {
  mockFetch.mockReset();
  (global as any).fetch = mockFetch;
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE = 'svc-key';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe('rememberFact', () => {
  it('posts the write_fact RPC over REST with service-role headers', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => 'fact-1' });
    const r = await rememberFact(base, { embed: false });
    expect(r).toEqual({ ok: true, fact_id: 'fact-1' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:54321/rest/v1/rpc/write_fact');
    expect(init.headers).toMatchObject({ apikey: 'svc-key', Authorization: 'Bearer svc-key' });
    expect(JSON.parse(init.body)).toEqual(buildWriteFactPayload(base));
  });

  it('uses a supplied client with the identical payload', async () => {
    const client = { rpc: jest.fn().mockResolvedValue({ data: 'fact-2', error: null }) };
    const r = await rememberFact(base, { client: client as any, embed: false });
    expect(r).toEqual({ ok: true, fact_id: 'fact-2' });
    expect(client.rpc).toHaveBeenCalledWith('write_fact', buildWriteFactPayload(base));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses an inferred write to an identity-class key before any RPC', async () => {
    const client = { rpc: jest.fn() };
    const r = await rememberFact(
      { ...base, fact_key: 'user_first_name', fact_value: 'Kemal' },
      { client: client as any },
    );
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe('identity_lock');
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('reports a failed RPC instead of throwing', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const r = await rememberFact(base, { embed: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('500');
  });

  it('reports a thrown transport error instead of throwing', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    await expect(rememberFact(base, { embed: false })).resolves.toEqual({ ok: false, error: 'network down' });
  });

  it('refuses an empty value and a missing user without a request', async () => {
    expect((await rememberFact({ ...base, fact_value: '  ' })).ok).toBe(false);
    expect((await rememberFact({ ...base, user_id: '' })).ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('omits the optional ids from the payload unless set', () => {
    expect(buildWriteFactPayload(base)).not.toHaveProperty('p_thread_id');
    expect(buildWriteFactPayload({ ...base, thread_id: 'th' })).toMatchObject({ p_thread_id: 'th' });
  });
});

describe('single fact-write path (source contract)', () => {
  const SRC = path.resolve(__dirname, '../../../src');
  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  }

  it('only services/memory/remember.ts calls the write_fact RPC', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith(path.join('services', 'memory', 'remember.ts')))
      .filter((f) => {
        const code = fs.readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '');
        return /rpc\/write_fact|rpc\(\s*['"]write_fact['"]/.test(code);
      })
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
