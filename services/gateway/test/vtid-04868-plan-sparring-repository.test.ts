/**
 * VTID-04868 hardening — the real Plan Sparring repository against a
 * recording fake Supabase client (no network, no database).
 *
 *   - finding 1: the session INSERT payload carries no `rounds` key
 *     (service_role has no INSERT privilege on that column);
 *   - finding 4: appendRound sends p_expected_round, and an RPC error or an
 *     `{ ok: false }` reply is a failure, PS409 a round conflict;
 *   - finding 5: the ledger read is a keyset page over (created_at, id) in
 *     [since, until).
 */
import {
  appendRound,
  fetchLedgerRowsWithoutSparring,
  insertSession,
  isRoundConflict,
  LEDGER_PAGE_SIZE,
} from '../src/services/plan-sparring/plan-sparring-repository';

type Op = [string, ...unknown[]];

/** A chainable query builder that records every call and resolves to `result`. */
function fakeSb(result: { data: unknown; error: unknown }) {
  const ops: Op[] = [];
  const builder: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result);
        return (...args: unknown[]) => {
          ops.push([prop, ...args]);
          return builder;
        };
      },
    },
  );
  const sb: any = {
    from: (table: string) => {
      ops.push(['from', table]);
      return builder;
    },
    rpc: async (fn: string, args: unknown) => {
      ops.push(['rpc', fn, args]);
      return result;
    },
  };
  return { sb, ops };
}

const ROW = {
  plan_id: '11111111-2222-4333-8444-555555555555',
  plan_hash: 'a'.repeat(64),
  producer: 'claude-code',
  change_class: 'standard' as const,
  trust_tier: 'gateway' as const,
  base_ref: 'b'.repeat(40),
};

describe('VTID-04868 plan-sparring repository (hardening)', () => {
  it('finding 1: insertSession never sends `rounds` (column default applies)', async () => {
    const { sb, ops } = fakeSb({ data: { id: 'x' }, error: null });
    await insertSession(sb, ROW);
    const insert = ops.find((o) => o[0] === 'insert');
    expect(insert).toBeDefined();
    const payload = insert![1] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(payload, 'rounds')).toBe(false);
    // Every key it does send is in the service_role INSERT column grant.
    const granted = ['id', 'plan_id', 'plan_hash', 'final_plan_hash', 'producer', 'change_class', 'trust_tier', 'base_ref',
      'verdict', 'escalation_reasons', 'model_log', 'human_approved_by', 'human_approved_at', 'approval_evidence'];
    for (const k of Object.keys(payload)) expect(granted).toContain(k);
    expect(payload).toEqual(expect.objectContaining({ ...ROW, verdict: 'in_progress' }));
  });

  it('finding 4: appendRound sends the expected round number', async () => {
    const { sb, ops } = fakeSb({ data: { ok: true, round_count: 2 }, error: null });
    const r = await appendRound(sb, 'sid', { round: 2 } as never, 2);
    expect(r.error).toBeNull();
    expect(ops).toEqual([['rpc', 'plan_sparring_append_round', { p_session: 'sid', p_round: { round: 2 }, p_expected_round: 2 }]]);
  });

  it('finding 4: a PS409 RPC error is a round conflict; an { ok: false } reply is an error, not a success', async () => {
    const conflict = await appendRound(fakeSb({ data: null, error: { code: 'PS409', message: 'round_conflict: session x has 2 round(s)' } }).sb, 's', {} as never, 2);
    expect(isRoundConflict(conflict.error)).toBe(true);
    const frozen = await appendRound(fakeSb({ data: { ok: false, error: 'SESSION_FROZEN' }, error: null }).sb, 's', {} as never, 2);
    expect(frozen.error).toEqual({ message: 'SESSION_FROZEN', code: 'SESSION_FROZEN' });
    expect(isRoundConflict(frozen.error)).toBe(false);
    expect(isRoundConflict({ message: 'round_conflict: x' })).toBe(true);
    expect(isRoundConflict(null)).toBe(false);
  });

  it('finding 5: the ledger read is a keyset page over (created_at, id) within [since, until)', async () => {
    const { sb, ops } = fakeSb({ data: [], error: null });
    await fetchLedgerRowsWithoutSparring(sb, '2026-10-04T10:00:00.000Z', {
      untilIso: '2026-10-04T11:00:00.000Z',
      after: { created_at: '2026-10-04T10:30:00.123456+00:00', id: 'row-9' },
    });
    expect(ops).toEqual([
      ['from', 'vtid_ledger'],
      ['select', 'id, vtid, created_at, metadata'],
      ['gte', 'created_at', '2026-10-04T10:00:00.000Z'],
      ['is', 'metadata->>sparring_id', null],
      ['lt', 'created_at', '2026-10-04T11:00:00.000Z'],
      ['or', 'created_at.gt."2026-10-04T10:30:00.123456+00:00",and(created_at.eq."2026-10-04T10:30:00.123456+00:00",id.gt."row-9")'],
      ['order', 'created_at', { ascending: true }],
      ['order', 'id', { ascending: true }],
      ['limit', LEDGER_PAGE_SIZE],
    ]);
  });

  it('finding 5: the first page has no keyset filter', async () => {
    const { sb, ops } = fakeSb({ data: [], error: null });
    await fetchLedgerRowsWithoutSparring(sb, '2026-10-04T10:00:00.000Z');
    expect(ops.map((o) => o[0])).not.toContain('or');
    expect(ops.map((o) => o[0])).not.toContain('lt');
  });
});
