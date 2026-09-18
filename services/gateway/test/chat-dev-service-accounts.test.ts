/**
 * VTID-03982 — GET /conversations and GET /unread-count must never surface
 * internal dev/automation accounts (claude-code-agent@exafy.io,
 * operator-autopilot@exafy.io) to a real community member.
 *
 * A 2026-09-16 bootstrap step had each of those two accounts send a
 * "Hello! My name is ..." intro DM to every community member, landing a
 * dev-only chat thread in 222+ real users' inboxes. Both accounts must be
 * filtered out regardless of which underlying data source served the
 * conversation list (the `get_recent_conversations` RPC, or its
 * client-side-dedup fallback when the RPC is unavailable), and their
 * unread messages must not inflate the unread-count badge for a thread the
 * user can no longer see or open.
 */

import request from 'supertest';
import express from 'express';

const CLAUDE_CODE_AGENT_ID = '887b34cb-9ee9-47dc-ad53-db5be1869846';
const OPERATOR_AUTOPILOT_ID = '856c30ed-7136-4bc5-8bfe-86a1e8ea1401';
const HUMAN_PEER_ID = 'human-peer-1';

// ── Chainable Supabase mock, extended with `.rpc()` ───────────────────────
function createChainableMock() {
  let fromResult: { data: any; error: any } = { data: null, error: null };
  let rpcResult: { data: any; error: any } = { data: null, error: null };

  const chain: any = {
    from: jest.fn(() => chain),
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    or: jest.fn(() => chain),
    not: jest.fn(() => chain),
    is: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    lt: jest.fn(() => chain),
    single: jest.fn(() => chain),
    maybeSingle: jest.fn(() => chain),
    then: jest.fn((resolve: any, reject: any) => Promise.resolve(fromResult).then(resolve, reject)),
    rpc: jest.fn(() => Promise.resolve(rpcResult)),
    setFromResult: (result: { data: any; error: any }) => {
      fromResult = result;
    },
    setRpcResult: (result: { data: any; error: any }) => {
      rpcResult = result;
    },
  };
  return chain;
}

let mockSupabase: ReturnType<typeof createChainableMock>;

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabase),
}));

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.identity = { user_id: 'user-1', tenant_id: 'tenant-1', vitana_id: 'user1handle' };
    return next();
  },
  requireTenant: (_req: any, _res: any, next: any) => next(),
  resolveVitanaId: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/services/notification-service', () => ({
  notifyUser: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatRouter = require('../src/routes/chat').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/chat', chatRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabase = createChainableMock();
});

function conversationRow(peerId: string, senderIsMe: boolean) {
  return {
    id: `msg-${peerId}`,
    tenant_id: 'tenant-1',
    sender_id: senderIsMe ? 'user-1' : peerId,
    receiver_id: senderIsMe ? peerId : 'user-1',
    peer_id: peerId,
    content: 'hi',
    read_at: null,
    created_at: new Date().toISOString(),
    message_type: 'text',
    metadata: {},
  };
}

describe('GET /conversations — dev/automation account filtering (VTID-03982)', () => {
  it('excludes dev accounts from the RPC (get_recent_conversations) path', async () => {
    mockSupabase.setRpcResult({
      data: [
        conversationRow(HUMAN_PEER_ID, false),
        conversationRow(CLAUDE_CODE_AGENT_ID, false),
        conversationRow(OPERATOR_AUTOPILOT_ID, false),
      ],
      error: null,
    });

    const res = await request(makeApp()).get('/api/v1/chat/conversations');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const peerIds = res.body.data.map((c: any) => c.peer_id);
    expect(peerIds).toEqual([HUMAN_PEER_ID]);
    expect(peerIds).not.toContain(CLAUDE_CODE_AGENT_ID);
    expect(peerIds).not.toContain(OPERATOR_AUTOPILOT_ID);
  });

  it('excludes dev accounts from the client-side-dedup fallback when the RPC is unavailable', async () => {
    mockSupabase.setRpcResult({ data: null, error: { message: 'function not found' } });
    mockSupabase.setFromResult({
      data: [
        conversationRow(HUMAN_PEER_ID, true),
        conversationRow(CLAUDE_CODE_AGENT_ID, false),
        conversationRow(OPERATOR_AUTOPILOT_ID, false),
      ],
      error: null,
    });

    const res = await request(makeApp()).get('/api/v1/chat/conversations');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const peerIds = res.body.data.map((c: any) => c.peer_id);
    expect(peerIds).toEqual([HUMAN_PEER_ID]);
    expect(peerIds).not.toContain(CLAUDE_CODE_AGENT_ID);
    expect(peerIds).not.toContain(OPERATOR_AUTOPILOT_ID);
  });
});

describe('GET /unread-count — dev/automation account filtering (VTID-03982)', () => {
  it('excludes messages sent by dev accounts from the unread count', async () => {
    mockSupabase.setFromResult({ count: 3, data: null, error: null });

    const res = await request(makeApp()).get('/api/v1/chat/unread-count');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // The count query must explicitly exclude the two dev-account senders —
    // otherwise a hidden thread would leave a permanently unclearable badge.
    expect(mockSupabase.not).toHaveBeenCalledWith(
      'sender_id',
      'in',
      expect.stringContaining(CLAUDE_CODE_AGENT_ID),
    );
    expect(mockSupabase.not).toHaveBeenCalledWith(
      'sender_id',
      'in',
      expect.stringContaining(OPERATOR_AUTOPILOT_ID),
    );
  });
});
