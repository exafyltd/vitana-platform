/**
 * live-room-edit-cohost / gateway-cohost — helper contract (services/live-cohosts.ts).
 *
 * isRoomHost: creator is host without any RPC; a listed co-host is host via
 * live_room_is_host (service role); an RPC error means "not host".
 * filterCoHosts: validates with live_room_filter_co_hosts; a missing function
 * raises CO_HOST_VALIDATION_UNAVAILABLE (never accepts unvalidated ids); dropped
 * ids are returned, never silently removed.
 */

import { isRoomHost, filterCoHosts, CoHostValidationUnavailableError } from '../src/services/live-cohosts';

type RpcCall = { fn: string; params: Record<string, unknown> };

function fakeSupa(handlers: Record<string, (params: any) => { data: any; error: any }>) {
  const calls: RpcCall[] = [];
  return {
    calls,
    rpc: async (fn: string, params: Record<string, unknown>) => {
      calls.push({ fn, params });
      const h = handlers[fn];
      if (!h) return { data: null, error: { code: '42883', message: `function ${fn} does not exist` } };
      return h(params);
    },
  } as any;
}

const ROOM = '11111111-1111-4111-8111-111111111111';
const CREATOR = '22222222-2222-4222-8222-222222222222';
const COHOST = '33333333-3333-4333-8333-333333333333';
const STRANGER = '44444444-4444-4444-8444-444444444444';

describe('isRoomHost', () => {
  it('creator is host and makes no RPC call', async () => {
    const supa = fakeSupa({});
    expect(await isRoomHost(supa, ROOM, CREATOR, CREATOR)).toBe(true);
    expect(supa.calls).toHaveLength(0);
  });

  it('a listed co-host is host via live_room_is_host (service role params)', async () => {
    const supa = fakeSupa({ live_room_is_host: () => ({ data: true, error: null }) });
    expect(await isRoomHost(supa, ROOM, COHOST, CREATOR)).toBe(true);
    expect(supa.calls).toEqual([{ fn: 'live_room_is_host', params: { p_room_id: ROOM, p_user_id: COHOST } }]);
  });

  it('an unlisted member is not host', async () => {
    const supa = fakeSupa({ live_room_is_host: () => ({ data: false, error: null }) });
    expect(await isRoomHost(supa, ROOM, STRANGER, CREATOR)).toBe(false);
  });

  it('an RPC failure means not host (creator unaffected, no throw)', async () => {
    const supa = fakeSupa({ live_room_is_host: () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) });
    expect(await isRoomHost(supa, ROOM, COHOST, CREATOR)).toBe(false);
    expect(await isRoomHost(supa, ROOM, CREATOR, CREATOR)).toBe(true);
  });
});

describe('filterCoHosts', () => {
  it('returns the validated list when every id passes', async () => {
    const supa = fakeSupa({
      live_room_filter_co_hosts: () => ({ data: [COHOST], error: null }),
    });
    const r = await filterCoHosts(supa, ROOM, CREATOR, [COHOST]);
    expect(r).toEqual({ ok: true, ids: [COHOST] });
  });

  it('reports dropped ids, never drops silently', async () => {
    const supa = fakeSupa({
      live_room_filter_co_hosts: () => ({ data: [COHOST], error: null }),
    });
    const r = await filterCoHosts(supa, ROOM, CREATOR, [COHOST, STRANGER]);
    expect(r).toEqual({ ok: false, code: 'INVALID_CO_HOSTS', dropped: [STRANGER] });
  });

  it('a missing validation function throws CO_HOST_VALIDATION_UNAVAILABLE', async () => {
    const supa = fakeSupa({});
    await expect(filterCoHosts(supa, ROOM, CREATOR, [COHOST])).rejects.toBeInstanceOf(CoHostValidationUnavailableError);
  });

  it('an empty list needs no RPC and is ok', async () => {
    const supa = fakeSupa({});
    expect(await filterCoHosts(supa, ROOM, CREATOR, [])).toEqual({ ok: true, ids: [] });
    expect(supa.calls).toHaveLength(0);
  });
});
