/**
 * Expanded reactions — gateway gate. While REACTION_EXPANDED_ENABLED is not "true" (the default), the ORB
 * react_to_message tool adds only the six quick reactions. Removals always work. With the flag on, any emoji of the
 * 181-emoji set is accepted. Keep the flag in step with the web and mobile REACTION_PICKER_ENABLED.
 */
import { tool_react_to_message } from '../../src/services/orb-tools/messaging-depth-tools';
import * as repo from '../../src/services/orb-tools/messaging-depth-tools-repository';
import { allowedReactionEmoji } from '../../src/services/orb-tools/reaction-emoji';

jest.mock('../../src/services/orb-tools/messaging-depth-tools-repository', () => ({
  ...jest.requireActual('../../src/services/orb-tools/messaging-depth-tools-repository'),
  fetchChatMessageForReaction: jest.fn(),
  fetchChatGroupMembership: jest.fn(),
  insertMessageReaction: jest.fn(),
  deleteMessageReaction: jest.fn(),
}));

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';
const APPLE = '\u{1F34E}';
const HEART = '\u2764\uFE0F';
const id = { user_id: ME } as never;
const sb = {} as never;

const prev = process.env.REACTION_EXPANDED_ENABLED;
afterEach(() => {
  if (prev === undefined) delete process.env.REACTION_EXPANDED_ENABLED;
  else process.env.REACTION_EXPANDED_ENABLED = prev;
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.REACTION_EXPANDED_ENABLED;
  (repo.fetchChatMessageForReaction as jest.Mock).mockResolvedValue({ data: { sender_id: OTHER, receiver_id: ME, group_id: null }, error: null });
  (repo.insertMessageReaction as jest.Mock).mockResolvedValue({ error: null });
  (repo.deleteMessageReaction as jest.Mock).mockResolvedValue({ error: null });
});

describe('allowedReactionEmoji', () => {
  it('allows only the six quick reactions while expanded is off', () => {
    expect(allowedReactionEmoji(HEART, false)).toBe(HEART);
    expect(allowedReactionEmoji('\u2764', false)).toBe(HEART); // legacy bare heart
    expect(allowedReactionEmoji(APPLE, false)).toBeNull();
  });
  it('allows the whole set when expanded is on', () => {
    expect(allowedReactionEmoji(APPLE, true)).toBe(APPLE);
    expect(allowedReactionEmoji('not-an-emoji', true)).toBeNull();
  });
});

describe('react_to_message with expanded reactions off (default)', () => {
  it('refuses to add an emoji outside the six and never calls the insert', async () => {
    const r = await tool_react_to_message({ message_id: MSG, emoji: APPLE }, id, sb);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must be one of/);
    expect(repo.insertMessageReaction).not.toHaveBeenCalled();
  });
  it('still adds a quick reaction', async () => {
    const r = await tool_react_to_message({ message_id: MSG, emoji: '\u{1F44D}' }, id, sb);
    expect(r.ok).toBe(true);
    expect(repo.insertMessageReaction).toHaveBeenCalledTimes(1);
  });
  it('removes an emoji outside the six (removal is never gated)', async () => {
    const r = await tool_react_to_message({ message_id: MSG, emoji: APPLE, remove: true }, id, sb);
    expect(r.ok).toBe(true);
    expect(repo.deleteMessageReaction).toHaveBeenCalledWith(expect.anything(), MSG, ME, APPLE);
  });
});

describe('react_to_message with REACTION_EXPANDED_ENABLED=true', () => {
  it('adds an emoji outside the six', async () => {
    process.env.REACTION_EXPANDED_ENABLED = 'true';
    const r = await tool_react_to_message({ message_id: MSG, emoji: APPLE }, id, sb);
    expect(r.ok).toBe(true);
    expect(repo.insertMessageReaction).toHaveBeenCalledWith(expect.anything(), MSG, ME, APPLE);
  });
});
