/**
 * BOOTSTRAP-ORB-UNREAD-MESSAGES-NAV — unread-messages-announce provider tests.
 *
 * Locks the contract:
 *   - Skips on missing inputs.
 *   - Suppresses (no_unread_messages) when the summary count is 0.
 *   - Errors when the repository throws.
 *   - Fires (status=returned, priority 93.5, kind=wake_brief) with real
 *     unread data, naming 1/2 senders and falling back to a count for 3+.
 *   - cta is a deterministic navigate to the inbox (screen_id INBOX.OVERVIEW).
 *   - dedupeKey changes with the unread state (count/senderCount).
 *   - EN + DE render, both grounded (no hardcoded finished sentence — the
 *     name/count are always the real, injected data).
 */

jest.mock('../../../../src/services/social-memory/social-memory-repository', () => ({
  fetchExclusions: jest.fn(),
  fetchUnreadMessageSummary: jest.fn(),
}));

import {
  fetchExclusions,
  fetchUnreadMessageSummary,
} from '../../../../src/services/social-memory/social-memory-repository';
import {
  makeUnreadMessagesAnnounceProvider,
  renderUnreadMessagesLine,
  UNREAD_MESSAGES_ANNOUNCE_PROVIDER_KEY,
  UNREAD_MESSAGES_ANNOUNCE_EXTRA_KEY,
  UNREAD_MESSAGES_ANNOUNCE_PRIORITY,
} from '../../../../src/services/assistant-continuation/providers/unread-messages-announce';

const mockFetchExclusions = fetchExclusions as jest.Mock;
const mockFetchUnreadMessageSummary = fetchUnreadMessageSummary as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchExclusions.mockResolvedValue({ blocked: new Set(), muted: new Set(), hidden_posts: new Set() });
});

function makeCtx(extraOverride: any = {}) {
  return {
    surface: 'orb_wake',
    sessionId: 's1',
    userId: 'u1',
    tenantId: 't1',
    extra: {
      [UNREAD_MESSAGES_ANNOUNCE_EXTRA_KEY]: {
        supabase: {},
        userId: 'u1',
        tenantId: 't1',
        lang: 'en',
        ...extraOverride,
      },
    },
  } as any;
}

describe('renderUnreadMessagesLine', () => {
  it('names the single sender, singular for count=1', () => {
    const line = renderUnreadMessagesLine({ lang: 'en', count: 1, senderCount: 1, senderNames: ['Anna'] });
    expect(line).toBe('You have a new message from Anna.');
  });

  it('names the single sender, plural for count>1', () => {
    const line = renderUnreadMessagesLine({ lang: 'en', count: 3, senderCount: 1, senderNames: ['Anna'] });
    expect(line).toBe('You have 3 new messages from Anna.');
  });

  it('names both senders for senderCount=2', () => {
    const line = renderUnreadMessagesLine({ lang: 'en', count: 5, senderCount: 2, senderNames: ['Anna', 'Tom'] });
    expect(line).toBe('You have new messages from Anna and Tom.');
  });

  it('falls back to count + sender count for 3+ senders (no names)', () => {
    const line = renderUnreadMessagesLine({ lang: 'en', count: 12, senderCount: 5, senderNames: [] });
    expect(line).toBe('You have 12 unread messages from 5 people.');
  });

  it('renders real German for the 1-sender and 3+-sender branches', () => {
    expect(renderUnreadMessagesLine({ lang: 'de', count: 1, senderCount: 1, senderNames: ['Anna'] })).toBe(
      'Du hast eine neue Nachricht von Anna.',
    );
    expect(renderUnreadMessagesLine({ lang: 'de', count: 12, senderCount: 5, senderNames: [] })).toBe(
      'Du hast 12 ungelesene Nachrichten von 5 Personen.',
    );
  });
});

describe('unread-messages-announce provider', () => {
  const baseOpts = { newId: () => 'fixed-id', now: () => 1_000 };

  it('has the right key and orb_wake surface', () => {
    const p = makeUnreadMessagesAnnounceProvider(baseOpts);
    expect(p.key).toBe(UNREAD_MESSAGES_ANNOUNCE_PROVIDER_KEY);
    expect(p.surfaces).toEqual(['orb_wake']);
  });

  it('skips when inputs are missing', async () => {
    const p = makeUnreadMessagesAnnounceProvider(baseOpts);
    const res = await p.produce({ surface: 'orb_wake', extra: {} } as any);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('no_unread_messages_inputs');
    expect(mockFetchUnreadMessageSummary).not.toHaveBeenCalled();
  });

  it('suppresses when there are zero unread messages', async () => {
    mockFetchUnreadMessageSummary.mockResolvedValue({ count: 0, senderCount: 0, senders: [] });
    const p = makeUnreadMessagesAnnounceProvider(baseOpts);
    const res = await p.produce(makeCtx());
    expect(res.status).toBe('suppressed');
    expect(res.reason).toBe('no_unread_messages');
  });

  it('errors when the repository throws', async () => {
    mockFetchUnreadMessageSummary.mockRejectedValue(new Error('boom'));
    const p = makeUnreadMessagesAnnounceProvider(baseOpts);
    const res = await p.produce(makeCtx());
    expect(res.status).toBe('errored');
    expect(res.reason).toMatch(/boom/);
  });

  it('fires with priority 93.5 and a grounded 1-sender line', async () => {
    mockFetchUnreadMessageSummary.mockResolvedValue({
      count: 3,
      senderCount: 1,
      senders: [{ person: { display_name: 'Anna', handle: 'anna1' }, unread_count: 3 }],
    });
    const p = makeUnreadMessagesAnnounceProvider(baseOpts);
    const res = await p.produce(makeCtx());
    expect(res.status).toBe('returned');
    expect(res.candidate?.priority).toBe(UNREAD_MESSAGES_ANNOUNCE_PRIORITY);
    expect(res.candidate?.priority).toBe(93.5);
    expect(res.candidate?.kind).toBe('wake_brief');
    expect(res.candidate?.userFacingLine).toBe('You have 3 new messages from Anna.');
  });

  it('sets a deterministic navigate cta to the inbox', async () => {
    mockFetchUnreadMessageSummary.mockResolvedValue({ count: 1, senderCount: 1, senders: [{ person: { display_name: 'Anna', handle: null }, unread_count: 1 }] });
    const p = makeUnreadMessagesAnnounceProvider(baseOpts);
    const res = await p.produce(makeCtx());
    expect(res.candidate?.cta).toEqual({
      type: 'navigate',
      route: '/inbox',
      payload: { screen_id: 'INBOX.OVERVIEW' },
    });
  });

  it('falls back to "someone"/"jemandem" when a person has no display_name or handle', async () => {
    mockFetchUnreadMessageSummary.mockResolvedValue({
      count: 1,
      senderCount: 1,
      senders: [{ person: { display_name: null, handle: null }, unread_count: 1 }],
    });
    const p = makeUnreadMessagesAnnounceProvider(baseOpts);
    const resEn = await p.produce(makeCtx({ lang: 'en' }));
    expect(resEn.candidate?.userFacingLine).toMatch(/someone/);
    const resDe = await p.produce(makeCtx({ lang: 'de' }));
    expect(resDe.candidate?.userFacingLine).toMatch(/jemandem/);
  });

  it('dedupeKey changes when the unread count or sender count changes', async () => {
    mockFetchUnreadMessageSummary.mockResolvedValue({
      count: 3,
      senderCount: 1,
      senders: [{ person: { display_name: 'Anna', handle: null }, unread_count: 3 }],
    });
    const p = makeUnreadMessagesAnnounceProvider(baseOpts);
    const res1 = await p.produce(makeCtx());
    mockFetchUnreadMessageSummary.mockResolvedValue({
      count: 4,
      senderCount: 1,
      senders: [{ person: { display_name: 'Anna', handle: null }, unread_count: 4 }],
    });
    const res2 = await p.produce(makeCtx());
    expect(res1.candidate?.dedupeKey).not.toEqual(res2.candidate?.dedupeKey);
  });

  it('reports count-only wording for 3+ senders (no names to fabricate)', async () => {
    mockFetchUnreadMessageSummary.mockResolvedValue({ count: 12, senderCount: 5, senders: [] });
    const p = makeUnreadMessagesAnnounceProvider(baseOpts);
    const res = await p.produce(makeCtx());
    expect(res.candidate?.userFacingLine).toBe('You have 12 unread messages from 5 people.');
  });

  it('resolves exclusions before the summary query (blocked senders never reach the line)', async () => {
    mockFetchUnreadMessageSummary.mockResolvedValue({ count: 1, senderCount: 1, senders: [{ person: { display_name: 'Anna', handle: null }, unread_count: 1 }] });
    const p = makeUnreadMessagesAnnounceProvider(baseOpts);
    await p.produce(makeCtx());
    expect(mockFetchExclusions).toHaveBeenCalledWith('u1');
    expect(mockFetchUnreadMessageSummary).toHaveBeenCalledWith('u1', 't1', expect.any(Set));
  });
});
