/**
 * VTID-04504 (Community Autopilot CA-4): create-with-me and connect drafts.
 * Public posts are only ever finished in the app; messages go by voice only
 * after the draft was read back; drafts are written in the member's language.
 */
process.env.NODE_ENV = 'test';

const mockDispatch = jest.fn();
jest.mock('../src/services/orb-tools-shared', () => ({
  dispatchOrbTool: (...a: unknown[]) => mockDispatch(...a),
}));

const mockExcluded = jest.fn(async () => new Set<string>());
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIds: () => mockExcluded(),
}));

const mockRouter = jest.fn();
jest.mock('../src/services/llm-router', () => ({
  callViaRouter: (...a: unknown[]) => mockRouter(...a),
}));
jest.mock('../src/i18n/server-locale', () => ({
  getUserLocale: jest.fn(async () => 'de'),
}));

import {
  checkActionPolicy,
  clientRouteFor,
  executeRecommendationAction,
  type ActionContext,
} from '../src/services/community-autopilot/action-registry';
import {
  buildDraftIntent,
  currentDraft,
  generateDraft,
  sanitizeDraft,
  withDraft,
} from '../src/services/community-autopilot/drafts';

const USER = 'aaaa1111-1111-4111-8111-111111111111';
const FRIEND = 'cccc3333-3333-4333-8333-333333333333';
const BOT = 'dddd4444-4444-4444-8444-444444444444';

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  userId: USER,
  tenantId: 'tenant-1',
  recommendationId: 'rec-9',
  recommendationTitle: 'Say hi to Ana',
  channel: 'app',
  ...over,
});

function runsSb() {
  const runs: Array<Record<string, any>> = [];
  return {
    runs,
    from: () => ({
      insert: async (row: Record<string, any>) => { runs.push(row); return { error: null }; },
      update: (patch: Record<string, any>) => ({
        eq: async (_c: string, id: string) => { runs.filter((r) => r.id === id).forEach((r) => Object.assign(r, patch)); return { error: null }; },
      }),
    }),
  } as any;
}

beforeEach(() => {
  mockDispatch.mockReset();
  mockRouter.mockReset();
  mockExcluded.mockReset();
  mockExcluded.mockResolvedValue(new Set<string>());
});

describe('post_to_feed — public, app only', () => {
  const post = { kind: 'post_to_feed', params: { draft: 'Heute 10.000 Schritte geschafft!' } };

  it('a spoken yes never publishes: voice gets needs_app, even when "confirmed"', () => {
    const out = checkActionPolicy(post, ctx({ channel: 'voice', confirmed: true }));
    expect(out?.status).toBe('needs_app');
  });

  it('from the app it opens the composer pre-filled with the draft', async () => {
    const out = await executeRecommendationAction(runsSb(), post, ctx());
    expect(out.status).toBe('navigate');
    expect((out as any).route).toBe(`/home?compose=1&draft=${encodeURIComponent('Heute 10.000 Schritte geschafft!')}`);
  });

  it('writes nothing server-side (no run, no tool call)', async () => {
    const sb = runsSb();
    await executeRecommendationAction(sb, post, ctx());
    expect(sb.runs).toHaveLength(0);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('media_upload — caption draft, app only', () => {
  it('routes to the Media Hub upload with the caption', () => {
    expect(clientRouteFor({ kind: 'media_upload', params: { caption: 'Morgenlauf' } }))
      .toBe('/comm/media-hub?upload=1&caption=Morgenlauf');
  });
  it('voice cannot carry it out', () => {
    expect(checkActionPolicy({ kind: 'media_upload', params: {} }, ctx({ channel: 'voice' }))?.status).toBe('needs_app');
  });
});

describe('send_chat_message — read back before a voice send', () => {
  const msg = { kind: 'send_chat_message', params: { recipient_user_id: FRIEND, recipient_label: 'Ana', body: 'Hallo Ana, Lust auf einen Spaziergang?' } };

  it('voice without confirmation gets a read-back that contains the draft', () => {
    const out = checkActionPolicy(msg, ctx({ channel: 'voice' }));
    expect(out?.status).toBe('needs_confirmation');
    expect((out as any).readback).toContain('Hallo Ana, Lust auf einen Spaziergang?');
    expect((out as any).readback).toContain('Ana');
  });

  it('confirmed voice sends through the shared chat tool', async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { message_id: 'm1' }, text: 'sent' });
    const out = await executeRecommendationAction(runsSb(), msg, ctx({ channel: 'voice', confirmed: true }));
    expect(out.status).toBe('executed');
    expect(mockDispatch).toHaveBeenCalledWith('send_chat_message', expect.objectContaining({ recipient_user_id: FRIEND, body: msg.params.body }), expect.anything(), expect.anything());
  });

  it('never messages a test/service account (rules 43-45)', async () => {
    mockExcluded.mockResolvedValue(new Set([BOT]));
    const out = await executeRecommendationAction(runsSb(), { ...msg, params: { ...msg.params, recipient_user_id: BOT } }, ctx());
    expect(out.status).toBe('failed');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('never messages yourself', async () => {
    const out = await executeRecommendationAction(runsSb(), { ...msg, params: { ...msg.params, recipient_user_id: USER } }, ctx());
    expect(out.status).toBe('failed');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('a message without a body or recipient is invalid', () => {
    expect(checkActionPolicy({ kind: 'send_chat_message', params: { recipient_user_id: FRIEND } }, ctx())?.status).toBe('invalid');
    expect(checkActionPolicy({ kind: 'send_chat_message', params: { body: 'x' } }, ctx())?.status).toBe('invalid');
  });
});

describe('drafts', () => {
  it('sanitizes labels, quotes and fences, and bounds the length', () => {
    expect(sanitizeDraft('post_to_feed', '```\nPost: "Hallo zusammen!"\n```')).toBe('Hallo zusammen!');
    expect(sanitizeDraft('media_upload', 'x'.repeat(900)).length).toBeLessThanOrEqual(300);
  });

  it('keeps each kind\'s text in its own field', () => {
    expect(currentDraft(withDraft({ kind: 'send_chat_message', params: {} }, 'Hi'))).toBe('Hi');
    expect(withDraft({ kind: 'post_to_feed', params: {} }, 'P').params?.draft).toBe('P');
    expect(withDraft({ kind: 'media_upload', params: {} }, 'C').params?.caption).toBe('C');
  });

  it('the intent is English instructions plus data, never a finished sentence to speak', () => {
    const intent = buildDraftIntent({ title: 'Share your streak', summary: '7 days of walking', action: { kind: 'post_to_feed', params: {} } });
    expect(intent).toMatch(/^Write a short community news-feed post/);
    expect(intent).toContain('Suggestion title: Share your streak');
    expect(intent).toContain('Do not invent facts');
  });

  it('asks the Bedrock-primary memory stage in the member\'s language', async () => {
    mockRouter.mockResolvedValue({ ok: true, text: '"Sieben Tage am Stück gelaufen!"', provider: 'bedrock' });
    const r = await generateDraft({} as any, USER, { title: 'Share your streak', summary: null, action: { kind: 'post_to_feed', params: {} } });
    expect(r).toEqual(expect.objectContaining({ ok: true, text: 'Sieben Tage am Stück gelaufen!' }));
    const [stage, , opts] = mockRouter.mock.calls[0];
    expect(stage).toBe('memory');
    expect(opts.systemPrompt).toMatch(/LANGUAGE: Respond ONLY in German/);
  });

  it('a failed generation is reported, never thrown', async () => {
    mockRouter.mockResolvedValue({ ok: false, error: 'both providers failed' });
    const r = await generateDraft({} as any, USER, { title: 't', summary: null, action: { kind: 'send_chat_message', params: {} } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('both providers failed');
  });
});
