/**
 * VTID-05099 — the proactive match message (VTID-01270) claims the member's
 * one proactive Vitana DM for their local day in companion_messages_ledger
 * before it sends (owner decision D1, sparring F2). A refused claim skips the
 * send; a ledger error fails OPEN so the existing message keeps working.
 */
const mockMatch = {
  fetchExistingProactiveMessage: jest.fn(),
  fetchTopDailyMatches: jest.fn(),
  fetchMatchTargets: jest.fn(),
  countSuggestedDailyMatches: jest.fn(),
  fetchUserMatchRevealPreference: jest.fn(),
  insertProactiveMatchChatMessage: jest.fn(),
};
jest.mock('../src/services/proactive-match-messenger-repository', () => mockMatch);
const mockCompanion = { fetchProfiles: jest.fn(), claimMessage: jest.fn(), finishMessage: jest.fn() };
jest.mock('../src/services/companion/companion-repository', () => mockCompanion);
const mockNotify = jest.fn();
jest.mock('../src/services/notification-service', () => ({ notifyUserAsync: (...a: unknown[]) => mockNotify(...a) }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

import { sendProactiveMatchMessages } from '../src/services/proactive-match-messenger';

const U = '11111111-1111-4111-8111-111111111111';
const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const params = { user_id: U, tenant_id: T, date: '2026-10-20' };

beforeAll(() => { process.env.SUPABASE_URL = 'http://x'; process.env.SUPABASE_SERVICE_ROLE = 'k'; });
beforeEach(() => {
  jest.clearAllMocks();
  mockMatch.fetchExistingProactiveMessage.mockResolvedValue({ data: [] });
  mockMatch.fetchTopDailyMatches.mockResolvedValue({ data: [{ id: 'm1', match_type: 'person', target_id: 't1', score: 80, reasons: {} }], error: null });
  mockMatch.fetchMatchTargets.mockResolvedValue({ data: [{ id: 't1', display_name: 'Ana', topic_keys: ['yoga'] }], error: null });
  mockMatch.countSuggestedDailyMatches.mockResolvedValue({ count: 1 });
  mockMatch.fetchUserMatchRevealPreference.mockResolvedValue({ data: null });
  mockMatch.insertProactiveMatchChatMessage.mockResolvedValue({ error: null });
  mockCompanion.fetchProfiles.mockResolvedValue([{ user_id: U, first_name: 'Dragan', timezone: 'Europe/Berlin' }]);
  mockCompanion.finishMessage.mockResolvedValue({ ok: true });
});

describe('VTID-05099: the match message shares the one-a-day slot', () => {
  it('claims the slot (live, proactive_match, new_match, card F5), sends, then marks it sent', async () => {
    mockCompanion.claimMessage.mockResolvedValue({ ok: true, claimed: true, id: 7 });
    const r = await sendProactiveMatchMessages(params);
    expect(r).toMatchObject({ ok: true, messages_sent: 1 });
    expect(mockCompanion.claimMessage.mock.calls[0][1]).toMatchObject({
      user_id: U, tenant_id: T, mode: 'live', sender: 'proactive_match', moment_key: 'new_match', card_type: 'F5',
    });
    expect(mockCompanion.claimMessage.mock.calls[0][1].local_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(mockMatch.insertProactiveMatchChatMessage).toHaveBeenCalledTimes(1);
    expect(mockCompanion.finishMessage).toHaveBeenCalledWith(expect.anything(), 7, 'sent', null, null);
  });

  it('a refused claim (another Vitana DM already today) skips the send and the push', async () => {
    mockCompanion.claimMessage.mockResolvedValue({ ok: true, claimed: false, reason: 'already_sent_today' });
    const r = await sendProactiveMatchMessages(params);
    expect(r).toMatchObject({ ok: true, messages_sent: 0, skipped_reason: 'companion_daily_limit' });
    expect(mockMatch.insertProactiveMatchChatMessage).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('a ledger error fails open: the match message still sends', async () => {
    mockCompanion.claimMessage.mockResolvedValue({ ok: false, error: 'function does not exist' });
    expect((await sendProactiveMatchMessages(params)).messages_sent).toBe(1);
    mockCompanion.claimMessage.mockRejectedValue(new Error('network'));
    expect((await sendProactiveMatchMessages(params)).messages_sent).toBe(1);
    expect(mockCompanion.finishMessage).not.toHaveBeenCalled();
  });

  it('a failed chat insert marks the claimed slot failed', async () => {
    mockCompanion.claimMessage.mockResolvedValue({ ok: true, claimed: true, id: 8 });
    mockMatch.insertProactiveMatchChatMessage.mockResolvedValue({ error: { message: 'boom' } });
    const r = await sendProactiveMatchMessages(params);
    expect(r.ok).toBe(false);
    expect(mockCompanion.finishMessage).toHaveBeenCalledWith(expect.anything(), 8, 'failed', null, null);
  });

  it('no qualifying matches: no claim is taken', async () => {
    mockMatch.fetchTopDailyMatches.mockResolvedValue({ data: [], error: null });
    await sendProactiveMatchMessages(params);
    expect(mockCompanion.claimMessage).not.toHaveBeenCalled();
  });
});
