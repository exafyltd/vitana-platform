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
const mockFetchNotificationTestActorFlag = jest.fn();
const mockCountTenantMembersExcluding = jest.fn();
const mockFetchTenantMemberIdsExcluding = jest.fn();
const mockInsertWelcomeChatMessagesBatch = jest.fn();
const mockMarkAppUserWelcomeChatSent = jest.fn();

jest.mock('../../src/services/welcome-chat-service-repository', () => ({
  fetchAppUserWelcomeChatSent: (...args: unknown[]) => mockFetchAppUserWelcomeChatSent(...args),
  fetchServiceBotAccountFlag: (...args: unknown[]) => mockFetchServiceBotAccountFlag(...args),
  fetchNotificationTestActorFlag: (...args: unknown[]) => mockFetchNotificationTestActorFlag(...args),
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
    mockFetchServiceBotAccountFlag.mockResolvedValue({ data: null, error: null });
    mockFetchNotificationTestActorFlag.mockResolvedValue({ data: null, error: null });
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

/**
 * VTID-05023: the gateway welcome path must skip the same accounts as the
 * fire_welcome_chat_on_membership() trigger: service_bot_accounts AND
 * notification_test_actors. Synthetic UUIDs only.
 */
describe('sendWelcomeChatMessages — service and test account skip (VTID-05023)', () => {
  const serviceAccountId = '00000000-0000-4000-8000-0000000000b1';
  const testAccountId = '00000000-0000-4000-8000-0000000000c1';
  const memberId = '00000000-0000-4000-8000-0000000000d1';
  const tenantId = 'tenant-1';
  const fakeSupabase = {} as any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockFetchAppUserWelcomeChatSent.mockResolvedValue({ data: { welcome_chat_sent: false }, error: null });
    mockFetchServiceBotAccountFlag.mockResolvedValue({ data: null, error: null });
    mockFetchNotificationTestActorFlag.mockResolvedValue({ data: null, error: null });
    mockMarkAppUserWelcomeChatSent.mockResolvedValue({ error: null });
    mockCountTenantMembersExcluding.mockResolvedValue({ count: 2, error: null });
    mockFetchTenantMemberIdsExcluding.mockResolvedValue({
      data: [{ user_id: 'member-1' }, { user_id: 'member-2' }],
      error: null,
    });
    mockInsertWelcomeChatMessagesBatch.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('(a) skips a registered service account', async () => {
    mockFetchServiceBotAccountFlag.mockResolvedValue({ data: { user_id: serviceAccountId }, error: null });

    const result = await sendWelcomeChatMessages(serviceAccountId, tenantId, 'operator-autopilot', fakeSupabase);

    expect(result).toEqual({ sent: 0, skipped: true, reason: 'service_bot_account' });
    expect(mockInsertWelcomeChatMessagesBatch).not.toHaveBeenCalled();
  });

  it('(b) sends the welcome to a normal member', async () => {
    const result = await sendWelcomeChatMessages(memberId, tenantId, 'Alex', fakeSupabase);

    expect(mockFetchNotificationTestActorFlag).toHaveBeenCalledWith(fakeSupabase, memberId);
    expect(result).toEqual({ sent: 2, skipped: false });
    expect(mockInsertWelcomeChatMessagesBatch).toHaveBeenCalledTimes(1);
  });

  it('(c) skips a registered test account listed in notification_test_actors', async () => {
    mockFetchNotificationTestActorFlag.mockResolvedValue({ data: { user_id: testAccountId }, error: null });

    const result = await sendWelcomeChatMessages(testAccountId, tenantId, 'Test Account', fakeSupabase);

    expect(result).toEqual({ sent: 0, skipped: true, reason: 'notification_test_actor' });
    expect(mockMarkAppUserWelcomeChatSent).toHaveBeenCalledWith(fakeSupabase, testAccountId);
    expect(mockCountTenantMembersExcluding).not.toHaveBeenCalled();
    expect(mockInsertWelcomeChatMessagesBatch).not.toHaveBeenCalled();
  });

  it('(d) fails closed when the notification_test_actors read fails: no welcome, warning logged', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockFetchNotificationTestActorFlag.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

    const result = await sendWelcomeChatMessages(memberId, tenantId, 'Alex', fakeSupabase);

    expect(result).toEqual({ sent: 0, skipped: true, reason: 'notification_test_actor_check_failed' });
    expect(mockCountTenantMembersExcluding).not.toHaveBeenCalled();
    expect(mockInsertWelcomeChatMessagesBatch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('notification_test_actors lookup failed'));
  });
});
