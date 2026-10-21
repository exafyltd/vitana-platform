/**
 * VTID-03587 — the text-DM surface dropped every tool call.
 *
 * The first test is the reported bug: a navigation tool ran, the assistant
 * narrated "Hier sind die neuesten Nachrichten…", and because chat.ts never
 * read `result.tool_calls`, nothing opened and the user got the same offer on
 * every subsequent turn.
 */

import { extractDmActions } from '../../src/services/chat/dm-tool-actions';

describe('VTID-03587 extractDmActions', () => {
  it('surfaces a resolved navigation (the reported bug)', () => {
    const actions = extractDmActions([
      {
        name: 'navigate',
        args: { question: 'zeig mir die neuesten Nachrichten' },
        result: { screen_id: 'COMM.NEWS_FEED', route: '/news', title: 'News Feed' },
        success: true,
      },
    ]);

    expect(actions).toEqual([
      { kind: 'navigate', screen_id: 'COMM.NEWS_FEED', route: '/news', title: 'News Feed' },
    ]);
  });

  it('prefers the resolved result over the raw args', () => {
    // navigate_to_screen fuzzy-resolves ids (COMM.MATCHES -> COMM.FIND_PARTNER_MATCHES
    // was observed in production), so the post-resolution value must win.
    const [action] = extractDmActions([
      {
        name: 'navigate_to_screen',
        args: { screen_id: 'COMM.MATCHES' },
        result: { screen_id: 'COMM.FIND_PARTNER_MATCHES', route: '/comm/find-partner' },
        success: true,
      },
    ]);

    expect(action.screen_id).toBe('COMM.FIND_PARTNER_MATCHES');
  });

  it('falls back to args when the handler returned no destination fields', () => {
    const [action] = extractDmActions([
      { name: 'navigate_to_screen', args: { screen_id: 'HOME.OVERVIEW', route: '/home' } },
    ]);
    expect(action).toMatchObject({ kind: 'navigate', screen_id: 'HOME.OVERVIEW', route: '/home' });
  });

  it('emits NO action for an unresolved consult', () => {
    // decision=ambiguous / decision=unknown is a real production outcome: the
    // assistant is meant to ask a clarifying question, not navigate somewhere
    // arbitrary. Emitting an action here would send the user to a wrong screen.
    expect(
      extractDmActions([{ name: 'navigate', args: { question: 'Einträge machen' }, result: {} }]),
    ).toEqual([]);
  });

  it('ignores a tool call that reported failure', () => {
    expect(
      extractDmActions([
        {
          name: 'navigate_to_screen',
          args: { screen_id: 'HOME.OVERVIEW' },
          result: { error: 'already there' },
          success: false,
        },
      ]),
    ).toEqual([]);
  });

  it('carries an identity redirect through as a client event', () => {
    expect(
      extractDmActions([
        {
          name: 'request_identity_redirect',
          args: { event: 'vitana:open-profile-edit', section: 'identity', field: 'birthday' },
          success: true,
        },
      ]),
    ).toEqual([
      {
        kind: 'redirect_event',
        event: 'vitana:open-profile-edit',
        section: 'identity',
        field: 'birthday',
      },
    ]);
  });

  it('ignores unrelated tools so the metadata stays a deliberate contract', () => {
    expect(
      extractDmActions([
        { name: 'search_memory', args: { q: 'x' }, result: { hits: 3 }, success: true },
        { name: 'send_chat_message', args: {}, success: true },
      ]),
    ).toEqual([]);
  });

  it('never throws on malformed input — the reply text must always survive', () => {
    expect(extractDmActions(undefined)).toEqual([]);
    expect(extractDmActions(null)).toEqual([]);
    expect(extractDmActions('not-an-array')).toEqual([]);
    expect(extractDmActions([])).toEqual([]);
    expect(extractDmActions([null, 42, 'x', {}, { name: '' }])).toEqual([]);
    expect(extractDmActions([{ name: 'navigate', args: null, result: null }])).toEqual([]);
  });

  it('collects multiple actions from one turn in order', () => {
    const actions = extractDmActions([
      { name: 'search_memory', success: true },
      { name: 'navigate', result: { screen_id: 'A.B', route: '/a' }, success: true },
      { name: 'request_identity_redirect', args: { event: 'e' }, success: true },
    ]);
    expect(actions.map((a) => a.kind)).toEqual(['navigate', 'redirect_event']);
  });
});
