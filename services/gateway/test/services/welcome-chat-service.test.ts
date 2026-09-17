/**
 * VTID-03990: guard against a registered service/automation account
 * triggering the welcome-chat broadcast.
 *
 * Incident: two service identities (claude-code-agent, operator-autopilot)
 * were provisioned directly and this code path fanned an identical intro
 * DM out to ~445 real community members before the guard below existed.
 */

const mockFetchAppUserWelcomeChatSent = jest.fn();
const mockFetchServiceBotAccountFlag = jest.fn();
const mockCountTenantMembersExcluding = jest.fn();
const mockFetchTenantMemberIdsExcluding = jest.fn();
const mockInsertWelcomeChatMessagesBatch = jest.fn();
const mockMarkAppUserWelcomeChatSent = jest.fn();

jest.mock('../../src/services/welcome-chat-service-repository', () => ({
  fetchAppUserWelcomeChatSent: (...args: unknown[]) => mockFetchAppUserWelcomeChatSent(...args),
  fetchServiceBotAccountFlag: (...args: unknown[]) => mockFetchServiceBotAccountFlag(...args),
  countTenantMembersExcluding: (...args: unknown[]) => mockCountTenantMembersExcluding(...args),
  fetchTenantMemberIdsExcluding: (...args: unknown[]) => mockFetchTenantMemberIdsExcluding(...args),
  insertWelcomeChatMessagesBatch: (...args: unknown[]) => mockInsertWelcomeChatMessagesBatch(...args),
  markAppUserWelcomeChatSent: (...args: unknown[]) => mockMarkAppUserWelcomeChatSent(...args),
}));

import { sendWelcomeChatMessages } from '../../src/services/welcome-chat-service';

describe('sendWelcomeChatMessages — service/automation account guard', () => {
  const userId = '887b34cb-9ee9-47dc-ad53-db5be1869846';
  const tenantId = 'tenant-1';
  const fakeSupabase = {} as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchAppUserWelcomeChatSent.mockResolvedValue({ data: { welcome_chat_sent: false }, error: null });
    mockMarkAppUserWelcomeChatSent.mockResolvedValue({ error: null });
  });

  it('skips the broadcast and marks sent when the account is a registered service/automation account', async () => {
    mockFetchServiceBotAccountFlag.mockResolvedValue({ data: { user_id: userId }, error: null });

    const result = await sendWelcomeChatMessages(userId, tenantId, 'claude-code-agent', fakeSupabase);

    expect(result).toEqual({ sent: 0, skipped: true, reason: 'service_bot_account' });
    expect(mockMarkAppUserWelcomeChatSent).toHaveBeenCalledWith(fakeSupabase, userId);
    expect(mockCountTenantMembersExcluding).not.toHaveBeenCalled();
    expect(mockInsertWelcomeChatMessagesBatch).not.toHaveBeenCalled();
  });

  it('fails closed (skips, does not fan out) when the service_bot_accounts lookup itself errors', async () => {
    mockFetchServiceBotAccountFlag.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

    const result = await sendWelcomeChatMessages(userId, tenantId, 'claude-code-agent', fakeSupabase);

    expect(result).toEqual({ sent: 0, skipped: true, reason: 'service_bot_account_check_failed' });
    expect(mockCountTenantMembersExcluding).not.toHaveBeenCalled();
    expect(mockInsertWelcomeChatMessagesBatch).not.toHaveBeenCalled();
  });

  it('proceeds to the normal fan-out for a real member not on the allowlist', async () => {
    mockFetchServiceBotAccountFlag.mockResolvedValue({ data: null, error: null });
    mockCountTenantMembersExcluding.mockResolvedValue({ count: 2, error: null });
    mockFetchTenantMemberIdsExcluding.mockResolvedValue({
      data: [{ user_id: 'member-1' }, { user_id: 'member-2' }],
      error: null,
    });
    mockInsertWelcomeChatMessagesBatch.mockResolvedValue({ error: null });

    const result = await sendWelcomeChatMessages('real-user', tenantId, 'Alex', fakeSupabase);

    expect(result).toEqual({ sent: 2, skipped: false });
    expect(mockInsertWelcomeChatMessagesBatch).toHaveBeenCalledTimes(1);
  });
});
