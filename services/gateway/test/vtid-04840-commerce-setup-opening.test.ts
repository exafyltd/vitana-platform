/**
 * VTID-04840 — Vitana sets up a supplier's business by voice (Commerce AI
 * setup slice 3). Voice only drafts: the draft reaches the screen as an
 * orb_directive and nothing is written until the supplier taps there.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  DRAFT_BUSINESS_SETUP_TOOL_NAME,
  commerceSetupTools,
  runDraftBusinessSetup,
  type CommerceSetupSession,
} from '../src/orb/live/tools/commerce-setup-tool';
import { buildLiveApiTools } from '../src/orb/live/tools/live-tool-catalog';
import { workSurfaceGreetingFields } from '../src/orb/profile/session-profile';
import {
  computeGreetingDecision,
  type GreetingDecisionContext,
} from '../src/services/conversation/compute-greeting-decision';
import type { SetupDraft } from '../src/services/commerce-ai-setup';

const FLAG = 'COMMERCE_AI_SETUP_ENABLED';
const ON = { [FLAG]: 'true' } as NodeJS.ProcessEnv;

function names(catalog: object[]): string[] {
  const out: string[] = [];
  for (const g of catalog as Array<Record<string, unknown>>) {
    if (Array.isArray(g.function_declarations)) for (const d of g.function_declarations as Array<{ name: string }>) out.push(d.name);
  }
  return out;
}

const DRAFT: SetupDraft = {
  website: 'https://kraeuter.example/',
  business: { display_name: 'Kräuterhaus', category: 'supplements_nutrition', country: 'DE', description: null, currency: 'EUR' },
  products: [],
  source: 'website',
  notes: [],
} as unknown as SetupDraft;

function commerceSession(over: Partial<CommerceSetupSession> = {}): CommerceSetupSession {
  return {
    sessionId: 's-1',
    lang: 'de',
    identity: { user_id: 'u-1' },
    assistantProfile: { surface: 'commerce' },
    ...over,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('the tool is declared on the commerce surface only, and only when AI setup is on', () => {
  const prev = process.env[FLAG];
  afterEach(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });

  test('off: the commerce catalog is unchanged', () => {
    delete process.env[FLAG];
    expect(commerceSetupTools()).toEqual([]);
    expect(names(buildLiveApiTools('authenticated', '/commerce', 'community'))).not.toContain(DRAFT_BUSINESS_SETUP_TOOL_NAME);
  });

  test('on: commerce gets it; the member surface and anonymous sessions never do', () => {
    process.env[FLAG] = 'true';
    expect(names(buildLiveApiTools('authenticated', '/commerce', 'community'))).toContain(DRAFT_BUSINESS_SETUP_TOOL_NAME);
    expect(names(buildLiveApiTools('authenticated', '/home', 'community'))).not.toContain(DRAFT_BUSINESS_SETUP_TOOL_NAME);
    expect(names(buildLiveApiTools('anonymous', '/commerce/join', undefined))).not.toContain(DRAFT_BUSINESS_SETUP_TOOL_NAME);
  });

  test('only the exact string "true" switches it on', () => {
    expect(commerceSetupTools({ [FLAG]: 'TRUE' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(commerceSetupTools(ON)).toHaveLength(1);
  });
});

describe('draft_business_setup drafts in the background and writes nothing', () => {
  test('returns at once, then hands the draft to the screen', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let resolveDraft: (v: unknown) => void = () => {};
    const draft = jest.fn(() => new Promise((r) => { resolveDraft = r; }));
    const s = commerceSession();
    const out = await runDraftBusinessSetup(s, { website: 'kraeuter.example' }, {
      send: (m) => sent.push(m), draft: draft as any, allow: () => true, env: ON,
    });
    expect(out.success).toBe(true);
    expect(out.result).toContain('nothing is saved');
    expect(draft).toHaveBeenCalledWith('https://kraeuter.example/', 'de');
    expect(sent.map((m) => m.directive)).toEqual(['commerce_setup_reading']);
    expect(s.commerceSetupDraft?.status).toBe('reading');

    // A second call while reading does not start another draft.
    const again = await runDraftBusinessSetup(s, { website: 'kraeuter.example' }, {
      send: (m) => sent.push(m), draft: draft as any, allow: () => true, env: ON,
    });
    expect(again.result).toMatch(/Still reading/);
    expect(draft).toHaveBeenCalledTimes(1);

    resolveDraft({ ok: true, draft: DRAFT });
    await flush();
    expect(sent.map((m) => m.directive)).toEqual(['commerce_setup_reading', 'commerce_setup_draft']);
    expect(sent[1]).toMatchObject({ type: 'orb_directive', draft: DRAFT });
    expect(s.commerceSetupDraft?.status).toBe('ready');
  });

  test('a failed read reaches the screen as an error code', async () => {
    const sent: Array<Record<string, unknown>> = [];
    await runDraftBusinessSetup(commerceSession(), { website: 'https://down.example' }, {
      send: (m) => sent.push(m), draft: async () => ({ ok: false, error: 'site_unreachable' }) as any, allow: () => true, env: ON,
    });
    await flush();
    expect(sent[1]).toMatchObject({ directive: 'commerce_setup_draft_failed', error: 'site_unreachable' });
  });

  test('a thrown draft is reported, never left reading', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const s = commerceSession();
    await runDraftBusinessSetup(s, { website: 'https://boom.example' }, {
      send: (m) => sent.push(m), draft: async () => { throw new Error('boom'); }, allow: () => true, env: ON,
    });
    await flush();
    expect(sent[1]).toMatchObject({ directive: 'commerce_setup_draft_failed', error: 'llm_unavailable' });
    expect(s.commerceSetupDraft?.status).toBe('failed');
  });

  test.each([
    ['switched off', commerceSession(), { website: 'a.example' }, {} as NodeJS.ProcessEnv, /not switched on/],
    ['another surface', commerceSession({ assistantProfile: { surface: 'vitanaland' } }), { website: 'a.example' }, ON, /commerce portal/],
    ['signed out', commerceSession({ identity: null }), { website: 'a.example' }, ON, /not signed in/],
    ['not a website', commerceSession(), { website: 'my shop' }, ON, /invalid_url/],
  ])('refuses when %s, without drafting or sending anything', async (_label, session, args, env, error) => {
    const sent: unknown[] = [];
    const draft = jest.fn();
    const out = await runDraftBusinessSetup(session, args, { send: (m) => sent.push(m), draft: draft as any, allow: () => true, env });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(error);
    expect(draft).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  test('shares the per-member draft limit with the portal', async () => {
    const draft = jest.fn();
    const out = await runDraftBusinessSetup(commerceSession(), { website: 'a.example' }, {
      send: () => {}, draft: draft as any, allow: () => false, env: ON,
    });
    expect(out.error).toMatch(/RATE_LIMITED/);
    expect(draft).not.toHaveBeenCalled();
  });

  test('the module never calls apply', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/orb/live/tools/commerce-setup-tool.ts'), 'utf8');
    // Code only: the header comment names the apply endpoint to say who writes.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/applySetupDraft|ai-setup\/apply|\/apply['"`]/);
  });
});

describe('the commerce setup opener', () => {
  function ctx(over: Partial<GreetingDecisionContext> = {}): GreetingDecisionContext {
    return {
      contextReadyResolved: true, isAnonymous: false, safeFastGreetingLive: false, reconnectCount: 0,
      lang: 'de', greetLang: 'de', bucket: 'today', timeAgo: 'earlier today', wasFailure: false,
      firstName: 'Mila', hasUserId: true, hasSupabase: true, hasPriorSession: true,
      greetingNeedsOnboarding: false, greetingIsFirstTime: false, lastFullBriefingDate: null,
      todayTz: '2026-10-02', localHour: 11, timezone: 'Europe/Berlin', timeOfDay: 'morning',
      proactiveLine: null, newdayOverview: null, resumeOverview: null, rotationSeed: 1, recentNbaKeys: [],
      currentRoute: '/commerce', currentScreenTitle: null, menuPhrases: [],
      openDecision: { mode: 'speak', source: 'baseline_lead', line: null },
      guidedTopicNarrationContent: null, wakeBriefDecisionId: null, silenceOnSkipEnabled: false,
      wakeBriefHasSelectedContinuation: false, voiceWakeBriefReason: null,
      surface: 'commerce', workSurfaceRole: 'commerce', workSurfaceHighlights: ['3 invites pending'],
      ...over,
    } as GreetingDecisionContext;
  }

  test('asks for the website as an intent, and names the drafting tool', () => {
    const d = computeGreetingDecision(ctx({ workSurfaceTask: 'commerce_setup' }));
    expect(d.wakeOpener).toBe('work_surface_open');
    expect(d.diag).toMatchObject({ task: 'commerce_setup', role: 'commerce' });
    expect(d.directive).toContain('INTENT:');
    expect(d.directive).toContain('website');
    expect(d.directive).toContain('draft_business_setup');
    expect(d.directive).not.toContain('3 invites pending');
    // NEVER rule 41: no scripted sentence.
    expect(d.directive).not.toMatch(/Say exactly|"[^"]{20,}"/);
  });

  test('without the task, the commerce opener is unchanged', () => {
    const d = computeGreetingDecision(ctx());
    expect(d.diag.task).toBeUndefined();
    expect(d.directive).toContain('3 invites pending');
  });

  test('the task only applies to the commerce role', () => {
    const d = computeGreetingDecision(ctx({ surface: 'command-hub', workSurfaceRole: 'developer', workSurfaceTask: 'commerce_setup' }));
    expect(d.diag.task).toBeUndefined();
  });
});

describe('the session asks for the opener only when opened from the setup sheet', () => {
  const prev = process.env[FLAG];
  afterEach(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });
  const profile = { surface: 'commerce', role: 'commerce', isWorkSurface: true } as any;

  test('first turn, commerce, switched on → commerce_setup', () => {
    process.env[FLAG] = 'true';
    expect(workSurfaceGreetingFields({ assistantProfile: profile, commerce_setup: true, turn_count: 0 }).workSurfaceTask).toBe('commerce_setup');
  });

  test('not on a later turn, not when off, not without the flag from the sheet, not on another surface', () => {
    process.env[FLAG] = 'true';
    expect(workSurfaceGreetingFields({ assistantProfile: profile, commerce_setup: true, turn_count: 2 }).workSurfaceTask).toBeUndefined();
    expect(workSurfaceGreetingFields({ assistantProfile: profile }).workSurfaceTask).toBeUndefined();
    expect(workSurfaceGreetingFields({
      assistantProfile: { surface: 'admin', role: 'admin', isWorkSurface: true } as any, commerce_setup: true,
    }).workSurfaceTask).toBeUndefined();
    delete process.env[FLAG];
    expect(workSurfaceGreetingFields({ assistantProfile: profile, commerce_setup: true }).workSurfaceTask).toBeUndefined();
  });

  test('the session start reads commerce_setup and the tool is dispatched', () => {
    const controller = fs.readFileSync(path.join(__dirname, '../src/orb/live/session/live-session-controller.ts'), 'utf8');
    expect(controller).toContain('commerce_setup: (body as any).commerce_setup === true');
    const orbLive = fs.readFileSync(path.join(__dirname, '../src/routes/orb-live.ts'), 'utf8');
    expect(orbLive).toContain("case 'draft_business_setup':");
  });
});
