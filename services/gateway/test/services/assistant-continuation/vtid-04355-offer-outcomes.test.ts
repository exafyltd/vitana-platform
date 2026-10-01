/**
 * VTID-04355 (WS-0.5) — one lifecycle for every offered action:
 * made → accepted | declined | ignored, each an OASIS event with offer_id,
 * provider, key and tool; an offer the model runs is cleared only after its
 * tool succeeds.
 */

import {
  detectDecline,
  recordPendingOffer,
  markAwaitingModelRun,
  getAwaitingOffer,
  settleOfferOnToolSuccess,
  __resetOfferOutcomesForTest,
  type PendingOffer,
} from '../../../src/services/assistant-continuation/offer-outcomes';
import {
  maybeBindAcceptance,
  type AcceptanceGateDeps,
} from '../../../src/services/assistant-continuation/acceptance-gate';

const flush = () => new Promise((r) => setImmediate(r));
const sb = {} as any;

beforeEach(() => __resetOfferOutcomesForTest());

describe('detectDecline', () => {
  it.each(['nein', 'Nein danke.', 'nö', 'nicht jetzt', 'no thanks', 'später', 'überspringen', 'nah, later'])(
    'declines: %p',
    (t) => expect(detectDecline(t)).toBe(true),
  );
  it.each([
    '',
    null,
    'ja',
    'zeig mir lieber meine nachrichten',
    'nein ich wollte eigentlich wissen wie mein schlaf letzte woche war',
    'know',
    'nothing',
  ])('does not decline: %p', (t) => expect(detectDecline(t as any)).toBe(false));
});

describe('recordPendingOffer', () => {
  function deps(previous: PendingOffer | null, writeOk = true) {
    const emit = jest.fn(() => Promise.resolve());
    const write = jest.fn(() => Promise.resolve(writeOk ? { ok: true } : { ok: false, reason: 'db down' }));
    return {
      emit,
      write,
      d: {
        read: jest.fn(() => Promise.resolve(previous)),
        write,
        emit,
        now: () => new Date('2026-09-23T12:00:00.000Z'),
        newId: () => 'offer-new',
      },
    };
  }

  it('writes the offer with id, source, provider and key, and emits made', async () => {
    const { d, emit, write } = deps(null);
    const r = await recordPendingOffer(sb, 'u1', {
      tool: 'activate_recommendation',
      payload: { id: 'rec-1' },
      source: 'wake_brief',
      provider: 'autopilot_recommendation',
      key: 'rec:rec-1',
      ttlMinutes: 5,
    }, d);
    await flush();
    expect(r.ok).toBe(true);
    expect(write).toHaveBeenCalledWith(sb, 'u1', {
      tool: 'activate_recommendation',
      payload: { id: 'rec-1' },
      offered_at: '2026-09-23T12:00:00.000Z',
      offer_id: 'offer-new',
      source: 'wake_brief',
      provider: 'autopilot_recommendation',
      key: 'rec:rec-1',
    }, 5);
    expect(emit).toHaveBeenCalledTimes(1);
    expect((emit.mock.calls[0] as any[])[0]).toBe('made');
  });

  it('a replaced unanswered offer is recorded as ignored, then the new one as made', async () => {
    const prev: PendingOffer = { tool: 'navigate_to_screen', offer_id: 'offer-old', source: 'navigator_ambiguous' };
    const { d, emit } = deps(prev);
    await recordPendingOffer(sb, 'u1', { tool: 'offer_x', source: 'offer_action', ttlMinutes: 5 }, d);
    await flush();
    expect(emit.mock.calls.map((c: any[]) => c[0])).toEqual(['ignored', 'made']);
    expect((emit.mock.calls[0] as any[])[2]).toBe(prev);
    expect((emit.mock.calls[0] as any[])[3]).toEqual({ reason: 'replaced', replaced_by: 'offer-new' });
  });

  it('an already-accepted previous offer is not re-counted as ignored', async () => {
    const { d, emit } = deps({ tool: 't', offer_id: 'o', accepted_at: '2026-09-23T11:59:00Z' });
    await recordPendingOffer(sb, 'u1', { tool: 'offer_x', source: 'offer_action', ttlMinutes: 5 }, d);
    await flush();
    expect(emit.mock.calls.map((c: any[]) => c[0])).toEqual(['made']);
  });

  it('a failed write emits nothing and reports the reason', async () => {
    const { d, emit } = deps(null, false);
    const r = await recordPendingOffer(sb, 'u1', { tool: 't', source: 'offer_action', ttlMinutes: 5 }, d);
    await flush();
    expect(r).toEqual({ ok: false, reason: 'db down' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('a throwing emit never fails the write', async () => {
    const { d } = deps(null);
    d.emit = jest.fn(() => { throw new Error('oasis down'); }) as any;
    await expect(recordPendingOffer(sb, 'u1', { tool: 't', source: 'offer_action', ttlMinutes: 5 }, d)).resolves.toMatchObject({ ok: true });
  });
});

describe('acceptance gate outcome events', () => {
  function gate(cta: PendingOffer | null) {
    const calls = { clear: 0, marked: 0 };
    const emitOutcome = jest.fn(() => Promise.resolve());
    const deps: AcceptanceGateDeps = {
      readPendingCta: async () => cta,
      clearPendingCta: async () => { calls.clear++; },
      markAccepted: async (userId, c, now) => { calls.marked++; markAwaitingModelRun(userId, c, now); },
      emitOutcome,
    };
    return { deps, calls, emitOutcome };
  }

  const nav: PendingOffer = { tool: 'navigate_to_screen', payload: { screen_id: 'A.B', route: '/a' }, offer_id: 'o1' };
  const rec: PendingOffer = { tool: 'activate_recommendation', payload: { id: 'rec-1' }, offer_id: 'o2' };

  it('"ja" on a navigation offer → accepted (auto_runs true), cleared, bound', async () => {
    const { deps, calls, emitOutcome } = gate(nav);
    const r = await maybeBindAcceptance({ userText: 'ja', userId: 'u1' }, deps);
    await flush();
    expect(r).toMatchObject({ tool: 'navigate_to_screen' });
    expect(calls.clear).toBe(1);
    expect(emitOutcome).toHaveBeenCalledWith('accepted', 'u1', nav, { auto_runs: true });
  });

  it('"ja" on a non-navigation offer → accepted (auto_runs false), marked for the model, not cleared', async () => {
    const { deps, calls, emitOutcome } = gate(rec);
    const r = await maybeBindAcceptance({ userText: 'ja gerne', userId: 'u1' }, deps);
    await flush();
    expect(r).toBeNull();
    expect(calls).toEqual({ clear: 0, marked: 1 });
    expect(emitOutcome).toHaveBeenCalledWith('accepted', 'u1', rec, { auto_runs: false });
    expect(getAwaitingOffer('u1')).toMatchObject({ tool: 'activate_recommendation', offer_id: 'o2' });
  });

  it('a second "ja" on an already-accepted offer emits nothing and changes nothing', async () => {
    const { deps, calls, emitOutcome } = gate({ ...rec, accepted_at: '2026-09-23T12:00:00Z' });
    expect(await maybeBindAcceptance({ userText: 'ja', userId: 'u1' }, deps)).toBeNull();
    await flush();
    expect(calls).toEqual({ clear: 0, marked: 0 });
    expect(emitOutcome).not.toHaveBeenCalled();
  });

  it('"nein" → declined, cleared, nothing bound', async () => {
    const { deps, calls, emitOutcome } = gate(rec);
    markAwaitingModelRun('u1', rec);
    expect(await maybeBindAcceptance({ userText: 'nein danke', userId: 'u1' }, deps)).toBeNull();
    await flush();
    expect(calls.clear).toBe(1);
    expect(emitOutcome).toHaveBeenCalledWith('declined', 'u1', rec, undefined);
    expect(getAwaitingOffer('u1')).toBeNull();
  });

  it('"nein" with no live offer reads, clears nothing, emits nothing', async () => {
    const { deps, calls, emitOutcome } = gate(null);
    expect(await maybeBindAcceptance({ userText: 'nein', userId: 'u1' }, deps)).toBeNull();
    expect(calls.clear).toBe(0);
    expect(emitOutcome).not.toHaveBeenCalled();
  });
});

describe('settleOfferOnToolSuccess', () => {
  it('clears the stored offer only when the tool matches the accepted offer', async () => {
    const clear = jest.fn(() => Promise.resolve());
    markAwaitingModelRun('u1', { tool: 'activate_recommendation', offer_id: 'o2' });
    expect(await settleOfferOnToolSuccess(sb, 'u1', 'search_memory', { clear })).toBe(false);
    expect(clear).not.toHaveBeenCalled();
    expect(await settleOfferOnToolSuccess(sb, 'u1', 'activate_recommendation', { clear })).toBe(true);
    expect(clear).toHaveBeenCalledWith(sb, 'u1');
    expect(getAwaitingOffer('u1')).toBeNull();
  });

  it('an awaiting entry expires after 10 minutes', () => {
    markAwaitingModelRun('u1', { tool: 't' }, 0);
    expect(getAwaitingOffer('u1', 10 * 60_000 + 1)).toBeNull();
  });

  it('no client or no user → false, never throws', async () => {
    expect(await settleOfferOnToolSuccess(null, 'u1', 't')).toBe(false);
    expect(await settleOfferOnToolSuccess(sb, null, 't')).toBe(false);
  });
});
