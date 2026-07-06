/**
 * Feedback + Settings voice tools (VTID-02768 / VTID-02772).
 *
 * Mocked SupabaseClient + mocked service modules — no network, no real DB.
 * Per tool: happy path (ok:true with speakable text containing the actual
 * content) and the unauthenticated case where applicable.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

jest.mock('../../src/services/report-to-specialist-core', () => ({
  executeReportToSpecialist: jest.fn(),
}));
jest.mock('../../src/services/persona-registry', () => ({
  pickPersonaForKind: jest.fn(),
  pickPersonaForKindForTenant: jest.fn(),
}));
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/services/social-connect-service', () => ({
  SUPPORTED_PROVIDERS: [
    'instagram', 'facebook', 'tiktok', 'youtube', 'linkedin', 'twitter', 'google',
  ],
  getUserConnections: jest.fn(),
  disconnectSocialAccount: jest.fn(),
}));
jest.mock('../../src/i18n/server-locale', () => ({
  invalidateUserLocale: jest.fn(),
}));

import { executeReportToSpecialist } from '../../src/services/report-to-specialist-core';
import {
  pickPersonaForKind,
  pickPersonaForKindForTenant,
} from '../../src/services/persona-registry';
import { emitOasisEvent } from '../../src/services/oasis-event-service';
import {
  getUserConnections,
  disconnectSocialAccount,
} from '../../src/services/social-connect-service';
import { invalidateUserLocale } from '../../src/i18n/server-locale';
import {
  FEEDBACK_SETTINGS_TOOL_HANDLERS,
  FEEDBACK_SETTINGS_TOOL_DECLARATIONS,
  tool_submit_bug_report,
  tool_submit_support_ticket,
  tool_submit_marketplace_dispute,
  tool_submit_account_issue,
  tool_list_my_tickets,
  tool_set_language,
  tool_set_theme,
  tool_set_voice_preferences,
  tool_list_connected_apps,
  tool_disconnect_app,
} from '../../src/services/orb-tools/feedback-settings-tools';

const IDENT = { user_id: 'u-1', tenant_id: 't-1', role: 'community' };
const ANON = { user_id: '', tenant_id: null, role: null };

const LONG_BUG_SUMMARY =
  'The save button on the profile edit screen does nothing when I tap it on my phone and my changes are lost';
const LONG_SUMMARY_12 =
  'I ordered a blue yoga mat two weeks ago and it still has not arrived';

// ---------------------------------------------------------------------------
// Chainable Supabase mock
// ---------------------------------------------------------------------------

type MockResult = { data?: unknown; error?: { message: string } | null };

function makeBuilder(result: MockResult) {
  const b: any = {};
  for (const m of ['select', 'eq', 'not', 'order', 'limit', 'insert', 'update', 'upsert', 'delete', 'is', 'in']) {
    b[m] = jest.fn(() => b);
  }
  b.single = jest.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }));
  b.maybeSingle = jest.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }));
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(resolve, reject);
  return b;
}

/** from(table) → the builder registered for that table (default: empty ok). */
function makeSb(tables: Record<string, any> = {}) {
  return {
    from: jest.fn((table: string) => tables[table] ?? makeBuilder({ data: null, error: null })),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  jest.clearAllMocks();
  (emitOasisEvent as jest.Mock).mockResolvedValue({ ok: true });
});

// ---------------------------------------------------------------------------
// Registry + declarations
// ---------------------------------------------------------------------------

const TOOL_NAMES = [
  'submit_bug_report', 'submit_support_ticket', 'submit_marketplace_dispute',
  'submit_account_issue', 'list_my_tickets',
  'set_language', 'set_theme', 'set_voice_preferences',
  'list_connected_apps', 'disconnect_app',
];

describe('exports', () => {
  it.each(TOOL_NAMES)('%s has a handler and a declaration', (name) => {
    expect(typeof FEEDBACK_SETTINGS_TOOL_HANDLERS[name]).toBe('function');
    const decl = FEEDBACK_SETTINGS_TOOL_DECLARATIONS.find((d) => d.name === name);
    expect(decl).toBeDefined();
    expect(typeof decl!.description).toBe('string');
  });

  it('declarations use the Vertex-safe OpenAPI subset (no default/minimum/maximum/format)', () => {
    const json = JSON.stringify(FEEDBACK_SETTINGS_TOOL_DECLARATIONS.map((d) => d.parameters));
    for (const banned of ['"default"', '"minimum"', '"maximum"', '"format"', '"examples"']) {
      expect(json).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// submit_bug_report
// ---------------------------------------------------------------------------

describe('tool_submit_bug_report', () => {
  it('routes to devon via the shared core and speaks the ticket number', async () => {
    (pickPersonaForKindForTenant as jest.Mock).mockResolvedValue('devon');
    (executeReportToSpecialist as jest.Mock).mockResolvedValue({
      decision: 'created',
      ticket: { id: 'tk-1', ticket_number: 'FB-2026-07-000123' },
      persona: 'devon',
      matched_keyword: null,
      confidence: null,
      rpc_decision: null,
      rpc_gate: null,
    });
    const res = await tool_submit_bug_report(
      { summary: LONG_BUG_SUMMARY, screen: '/profile/edit' }, IDENT, makeSb(),
    );
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('FB-2026-07-000123');
    expect((res as any).text).toContain('bug report');
    expect((res as any).result.specialist).toBe('devon');
    // Core called with the resolved specialist hint (gate deliberately skipped).
    expect(executeReportToSpecialist).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'bug', specialist_hint: 'devon' }),
      expect.objectContaining({ user_id: 'u-1', tenant_id: 't-1' }),
      expect.anything(),
      expect.objectContaining({ source: 'orb-voice-typed-tool', screen_path: '/profile/edit' }),
    );
  });

  it('asks for specifics when the summary is under 15 words', async () => {
    const res = await tool_submit_bug_report(
      { summary: 'The app is broken please fix it now' }, IDENT, makeSb(),
    );
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('ASK_FOR_SPECIFICS');
    expect(executeReportToSpecialist).not.toHaveBeenCalled();
  });

  it('requires an authenticated user', async () => {
    const res = await tool_submit_bug_report({ summary: LONG_BUG_SUMMARY }, ANON as any, makeSb());
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('authenticated');
  });
});

// ---------------------------------------------------------------------------
// submit_support_ticket / submit_marketplace_dispute / submit_account_issue
// (unrouted path — VTID-03044 canary: sage/atlas/mira disabled)
// ---------------------------------------------------------------------------

describe('typed tickets without an enabled specialist (VTID-03044 canary)', () => {
  function insertCapture() {
    const builder = makeBuilder({ data: { id: 'tk-2', ticket_number: 'FB-2026-07-000124' }, error: null });
    return { sb: makeSb({ feedback_tickets: builder }), builder };
  }

  it('submit_support_ticket files an unrouted ticket and confirms', async () => {
    (pickPersonaForKindForTenant as jest.Mock).mockResolvedValue(null);
    const { sb, builder } = insertCapture();
    const res = await tool_submit_support_ticket(
      { summary: 'How can I export all of my health data as a file from the app' }, IDENT, sb,
    );
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('FB-2026-07-000124');
    expect((res as any).result.specialist).toBeNull();
    expect(executeReportToSpecialist).not.toHaveBeenCalled();
    const inserted = builder.insert.mock.calls[0][0];
    expect(inserted).toMatchObject({
      user_id: 'u-1',
      kind: 'support_question',
      status: 'new',
      resolver_agent: null,
    });
    expect(inserted.structured_fields).toMatchObject({ voice_origin: true, source: 'orb-voice-typed-tool' });
    expect(emitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'feedback.ticket.created' }),
    );
  });

  it('submit_marketplace_dispute stores the order reference', async () => {
    (pickPersonaForKindForTenant as jest.Mock).mockResolvedValue(null);
    const { sb, builder } = insertCapture();
    const res = await tool_submit_marketplace_dispute(
      { summary: LONG_SUMMARY_12, order_reference: 'ORD-4711' }, IDENT, sb,
    );
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('marketplace dispute');
    expect(builder.insert.mock.calls[0][0]).toMatchObject({ kind: 'marketplace_claim' });
    expect(builder.insert.mock.calls[0][0].structured_fields).toMatchObject({ order_reference: 'ORD-4711' });
  });

  it('submit_account_issue files kind=account_issue', async () => {
    (pickPersonaForKindForTenant as jest.Mock).mockResolvedValue(null);
    const { sb, builder } = insertCapture();
    const res = await tool_submit_account_issue(
      { summary: 'I cannot log into my account since yesterday even after resetting the password' }, IDENT, sb,
    );
    expect(res.ok).toBe(true);
    expect(builder.insert.mock.calls[0][0]).toMatchObject({ kind: 'account_issue' });
  });

  it('uses the platform-level resolver when there is no tenant', async () => {
    (pickPersonaForKind as jest.Mock).mockResolvedValue(null);
    const { sb } = insertCapture();
    const res = await tool_submit_support_ticket(
      { summary: 'How can I export all of my health data as a file from the app' },
      { ...IDENT, tenant_id: null }, sb,
    );
    expect(res.ok).toBe(true);
    expect(pickPersonaForKind).toHaveBeenCalledWith('support_question');
    expect(pickPersonaForKindForTenant).not.toHaveBeenCalled();
  });

  it('surfaces insert failures as ok:false', async () => {
    (pickPersonaForKindForTenant as jest.Mock).mockResolvedValue(null);
    const sb = makeSb({ feedback_tickets: makeBuilder({ data: null, error: { message: 'boom' } }) });
    const res = await tool_submit_account_issue(
      { summary: 'I cannot log into my account since yesterday even after resetting the password' }, IDENT, sb,
    );
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('boom');
  });

  it('requires an authenticated user', async () => {
    for (const handler of [tool_submit_support_ticket, tool_submit_marketplace_dispute, tool_submit_account_issue]) {
      const res = await handler({ summary: LONG_SUMMARY_12 }, ANON as any, makeSb());
      expect(res.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// list_my_tickets
// ---------------------------------------------------------------------------

describe('tool_list_my_tickets', () => {
  it('lists open tickets with number, kind, and speakable status', async () => {
    const rows = [
      { id: 'tk-1', ticket_number: 'FB-2026-07-000123', kind: 'bug', status: 'in_progress', created_at: '2026-07-01T10:00:00Z' },
      { id: 'tk-2', ticket_number: 'FB-2026-06-000090', kind: 'support_question', status: 'new', created_at: '2026-06-28T09:00:00Z' },
    ];
    const res = await tool_list_my_tickets({}, IDENT, makeSb({ feedback_tickets: makeBuilder({ data: rows, error: null }) }));
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('2 open ticket(s)');
    expect((res as any).text).toContain('FB-2026-07-000123');
    expect((res as any).text).toContain('bug report, in progress');
    expect((res as any).text).toContain('FB-2026-06-000090');
    expect((res as any).text).toContain('support question, received');
  });

  it('answers plainly when there are no open tickets', async () => {
    const res = await tool_list_my_tickets({}, IDENT, makeSb({ feedback_tickets: makeBuilder({ data: [], error: null }) }));
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('NO open tickets');
  });

  it('requires an authenticated user', async () => {
    const res = await tool_list_my_tickets({}, ANON as any, makeSb());
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// set_language
// ---------------------------------------------------------------------------

describe('tool_set_language', () => {
  it('writes user_preferences.stt_language + app_users.locale and busts the cache', async () => {
    const prefs = makeBuilder({ data: null, error: null });
    const appUsers = makeBuilder({ data: null, error: null });
    const res = await tool_set_language(
      { language: 'de' }, IDENT, makeSb({ user_preferences: prefs, app_users: appUsers }),
    );
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('German');
    expect(prefs.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u-1', stt_language: 'de-DE' }),
      { onConflict: 'user_id' },
    );
    expect(appUsers.update).toHaveBeenCalledWith(expect.objectContaining({ locale: 'de' }));
    expect(invalidateUserLocale).toHaveBeenCalledWith('u-1');
    expect((res as any).result).toMatchObject({ language: 'de', stt_language: 'de-DE' });
  });

  it('accepts full locale codes like en-US', async () => {
    const prefs = makeBuilder({ data: null, error: null });
    const res = await tool_set_language({ language: 'en-US' }, IDENT, makeSb({ user_preferences: prefs }));
    expect(res.ok).toBe(true);
    expect(prefs.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ stt_language: 'en-US' }),
      { onConflict: 'user_id' },
    );
  });

  it('rejects unsupported languages', async () => {
    const res = await tool_set_language({ language: 'fr' }, IDENT, makeSb());
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('Unsupported language');
  });

  it('requires an authenticated user', async () => {
    const res = await tool_set_language({ language: 'de' }, ANON as any, makeSb());
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// set_theme (graceful — no server-side storage)
// ---------------------------------------------------------------------------

describe('tool_set_theme', () => {
  it('explains the theme is a device setting and where to change it', async () => {
    const sb = makeSb();
    const res = await tool_set_theme({ theme: 'dark' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).result).toMatchObject({ persisted: false, requested_theme: 'dark' });
    expect((res as any).text).toContain('device setting');
    expect((res as any).text).toContain('Settings');
    expect((sb as any).from).not.toHaveBeenCalled();
  });

  it('rejects unknown themes', async () => {
    const res = await tool_set_theme({ theme: 'neon' }, IDENT, makeSb());
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// set_voice_preferences
// ---------------------------------------------------------------------------

describe('tool_set_voice_preferences', () => {
  it('maps pace/voice/tone onto the real user_preferences tts_* columns', async () => {
    const prefs = makeBuilder({ data: null, error: null });
    const res = await tool_set_voice_preferences(
      { pace: 'slow', tone: 'calm' }, IDENT, makeSb({ user_preferences: prefs }),
    );
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('pace slow');
    expect((res as any).text).toContain('"calm"');
    expect(prefs.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u-1', tts_speed: 0.8, tts_character: 'calm' }),
      { onConflict: 'user_id' },
    );
  });

  it('errors when nothing was provided to change', async () => {
    const res = await tool_set_voice_preferences({}, IDENT, makeSb());
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('Nothing to change');
  });

  it('requires an authenticated user', async () => {
    const res = await tool_set_voice_preferences({ pace: 'fast' }, ANON as any, makeSb());
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// list_connected_apps
// ---------------------------------------------------------------------------

describe('tool_list_connected_apps', () => {
  it('lists social + AI connections with display names', async () => {
    (getUserConnections as jest.Mock).mockResolvedValue([
      { provider: 'google', username: 'd', display_name: 'D', avatar_url: '', profile_url: '', enrichment_status: 'completed', connected_at: '2026-05-01T00:00:00Z' },
      { provider: 'youtube', username: 'd', display_name: 'D', avatar_url: '', profile_url: '', enrichment_status: 'completed', connected_at: '2026-06-01T00:00:00Z' },
    ]);
    const ai = makeBuilder({ data: [{ connector_id: 'openai', connected_at: '2026-06-15T00:00:00Z' }], error: null });
    const res = await tool_list_connected_apps({}, IDENT, makeSb({ user_connections: ai }));
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('3 connected app(s)');
    expect((res as any).text).toContain('Google');
    expect((res as any).text).toContain('YouTube');
    expect((res as any).text).toContain('OpenAI (ChatGPT) (AI assistant)');
  });

  it('answers plainly when nothing is connected', async () => {
    (getUserConnections as jest.Mock).mockResolvedValue([]);
    const res = await tool_list_connected_apps({}, IDENT, makeSb({ user_connections: makeBuilder({ data: [], error: null }) }));
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('NO connected apps');
  });

  it('requires an authenticated user', async () => {
    const res = await tool_list_connected_apps({}, ANON as any, makeSb());
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// disconnect_app
// ---------------------------------------------------------------------------

describe('tool_disconnect_app', () => {
  it('asks for confirmation before disconnecting', async () => {
    const res = await tool_disconnect_app({ provider: 'google' }, IDENT, makeSb());
    expect(res.ok).toBe(true);
    expect((res as any).result.requires_confirmation).toBe(true);
    expect((res as any).text).toContain('Google');
    expect((res as any).text).toContain('confirm');
    expect(disconnectSocialAccount).not.toHaveBeenCalled();
  });

  it('disconnects a social provider via disconnectSocialAccount after confirm', async () => {
    (disconnectSocialAccount as jest.Mock).mockResolvedValue({ ok: true });
    const social = makeBuilder({ data: { id: 'sc-1' }, error: null });
    const res = await tool_disconnect_app(
      { provider: 'google', confirm: true }, IDENT, makeSb({ social_connections: social }),
    );
    expect(res.ok).toBe(true);
    expect((res as any).result).toMatchObject({ disconnected: true, provider: 'google', category: 'app' });
    expect((res as any).text).toContain('Google is disconnected');
    expect(disconnectSocialAccount).toHaveBeenCalledWith(expect.anything(), 'u-1', 'google');
  });

  it('soft-disconnects an AI assistant connection and purges its key', async () => {
    const social = makeBuilder({ data: null, error: null });
    const userConn = makeBuilder({ data: { id: 'uc-1' }, error: null });
    const creds = makeBuilder({ data: null, error: null });
    const res = await tool_disconnect_app(
      { provider: 'chatgpt', confirm: true }, IDENT,
      makeSb({ social_connections: social, user_connections: userConn, ai_assistant_credentials: creds }),
    );
    expect(res.ok).toBe(true);
    expect((res as any).result).toMatchObject({ disconnected: true, provider: 'openai', category: 'ai_assistant' });
    expect(userConn.update).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
    expect(creds.update).toHaveBeenCalledWith(expect.objectContaining({ last_verify_status: 'purged' }));
  });

  it('says so plainly when the provider is not connected', async () => {
    const res = await tool_disconnect_app(
      { provider: 'spotify', confirm: true }, IDENT,
      makeSb({ social_connections: makeBuilder({ data: null, error: null }), user_connections: makeBuilder({ data: null, error: null }) }),
    );
    expect(res.ok).toBe(true);
    expect((res as any).result).toMatchObject({ disconnected: false, reason: 'not_connected' });
    expect((res as any).text).toContain('not connected');
  });

  it('requires an authenticated user', async () => {
    const res = await tool_disconnect_app({ provider: 'google', confirm: true }, ANON as any, makeSb());
    expect(res.ok).toBe(false);
  });
});
