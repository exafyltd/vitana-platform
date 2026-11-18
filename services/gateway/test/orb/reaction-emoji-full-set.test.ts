/**
 * Full emoji reactions — gateway side. The supported set is reaction-emojis.json
 * (identical copies in vitana-v1 and this service). The pin below must match the
 * copy in vitana-v1 (src/lib/reactions/reaction-emojis.json) and its mobile twin;
 * if this fails after editing the list, update the pin here AND in vitana-v1.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { normalizeReactionEmoji, REACTION_EMOJIS, QUICK_REACTIONS, MAX_DISTINCT_REACTIONS_PER_USER } from '../../src/services/orb-tools/reaction-emoji';
import { tool_react_to_message } from '../../src/services/orb-tools/messaging-depth-tools';
import * as repo from '../../src/services/orb-tools/messaging-depth-tools-repository';

const PINNED_SHA256 = 'cfc4c44c2c4b320462275ea7d8b428cc737fe2e88ce5b922e8a61555d5f5d1ae';

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
const id = { user_id: ME } as never;
const sb = {} as never;

describe('shared reaction emoji list', () => {
  it('matches the pinned copy (parity with vitana-v1)', () => {
    const raw = readFileSync(join(__dirname, '../../src/services/orb-tools/reaction-emojis.json'));
    expect(createHash('sha256').update(raw).digest('hex')).toBe(PINNED_SHA256);
  });

  it('has the six quick reactions and the full picker set, canonical and unique', () => {
    expect(QUICK_REACTIONS).toEqual(['👍', '❤️', '😂', '😮', '🙏', '🎉']);
    expect(REACTION_EMOJIS.length).toBeGreaterThan(100);
    expect(new Set(REACTION_EMOJIS).size).toBe(REACTION_EMOJIS.length);
    expect(MAX_DISTINCT_REACTIONS_PER_USER).toBe(6);
  });

  it('normalizes the legacy bare heart to the canonical heart and rejects unknown emoji', () => {
    expect(normalizeReactionEmoji('❤')).toBe('❤️');
    expect(normalizeReactionEmoji('❤️')).toBe('❤️');
    expect(normalizeReactionEmoji('🍎')).toBe('🍎');
    expect(normalizeReactionEmoji('not-an-emoji')).toBeNull();
  });
});

describe('react_to_message', () => {
  // Expanded reactions are gated off by default (test/orb/reaction-expanded-gate.test.ts). These cases cover the on state.
  const prevExpanded = process.env.REACTION_EXPANDED_ENABLED;
  afterAll(() => {
    if (prevExpanded === undefined) delete process.env.REACTION_EXPANDED_ENABLED;
    else process.env.REACTION_EXPANDED_ENABLED = prevExpanded;
  });
  beforeEach(() => {
    process.env.REACTION_EXPANDED_ENABLED = 'true';
    jest.clearAllMocks();
    (repo.fetchChatMessageForReaction as jest.Mock).mockResolvedValue({
      data: { sender_id: OTHER, receiver_id: ME, group_id: null },
      error: null,
    });
    (repo.insertMessageReaction as jest.Mock).mockResolvedValue({ error: null });
    (repo.deleteMessageReaction as jest.Mock).mockResolvedValue({ error: null });
  });

  it('accepts an emoji outside the six quick reactions', async () => {
    const res = await tool_react_to_message({ message_id: MSG, emoji: '🍎' }, id, sb);
    expect(res.ok).toBe(true);
    expect(repo.insertMessageReaction).toHaveBeenCalledWith(sb, MSG, ME, '🍎');
  });

  it('stores a legacy bare heart as the canonical heart', async () => {
    const res = await tool_react_to_message({ message_id: MSG, emoji: '❤' }, id, sb);
    expect(res.ok).toBe(true);
    expect(repo.insertMessageReaction).toHaveBeenCalledWith(sb, MSG, ME, '❤️');
  });

  it('rejects an unsupported emoji without touching the database', async () => {
    const res = await tool_react_to_message({ message_id: MSG, emoji: 'nope' }, id, sb);
    expect(res.ok).toBe(false);
    expect(repo.insertMessageReaction).not.toHaveBeenCalled();
  });

  it('reports the cap in words when the database rejects a seventh distinct emoji', async () => {
    (repo.insertMessageReaction as jest.Mock).mockResolvedValue({ error: { message: 'reaction_cap_reached' } });
    const res = await tool_react_to_message({ message_id: MSG, emoji: '🍎' }, id, sb);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/six different emojis/);
  });

  it('still removes a reaction (removal is never capped)', async () => {
    const res = await tool_react_to_message({ message_id: MSG, emoji: '❤', remove: true }, id, sb);
    expect(res.ok).toBe(true);
    expect(repo.deleteMessageReaction).toHaveBeenCalledWith(sb, MSG, ME, '❤️');
  });
});
