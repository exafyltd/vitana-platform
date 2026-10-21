// VTID-01089 — unit tests for the Autopilot Matchmaking Prompts service.
// Covers: user preference get/update (fallback + PATCH-vs-INSERT branch),
// deterministic prompt generation from matches_daily (enabled/quiet-hours/
// rate-limit gates, dedup against existing prompts, per-match-type message
// assembly, insert failure handling, OASIS event emission), today's-prompts
// read path, and prompt action execution (yes/not_now/options).
//
// This module reads SUPABASE_URL/SUPABASE_SERVICE_ROLE into module-level
// consts at import time, so every test loads a fresh module instance via
// `freshModule()` (jest.resetModules() + require) after setting/deleting
// env vars — mirroring the pattern in dev-autopilot-outcomes.test.ts.

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
  jest.resetModules();
});

function freshModule(opts: { missingUrl?: boolean; missingKey?: boolean } = {}) {
  process.env = { ...ORIGINAL_ENV };
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
  if (opts.missingUrl) delete process.env.SUPABASE_URL;
  if (opts.missingKey) delete process.env.SUPABASE_SERVICE_ROLE;
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../src/services/autopilot-prompts-service') as typeof import('../../src/services/autopilot-prompts-service');
}

function jsonRes(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function textRes(text: string, ok = false, status = 500) {
  return { ok, status, json: async () => ({}), text: async () => text };
}

/** Generic dispatcher: routes are checked in order, first match wins.
 *  Anything unmatched (e.g. oasis_events, unless overridden) resolves ok. */
function buildFetch(routes: Array<{ when: (url: string, method: string) => boolean; res: any }>) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = jest.fn(async (url: string, init: any = {}) => {
    calls.push({ url, init });
    const method = (init.method || 'GET').toUpperCase();
    for (const r of routes) {
      if (r.when(url, method)) return typeof r.res === 'function' ? r.res(url, init) : r.res;
    }
    return jsonRes({});
  });
  return { fn, calls };
}

const isRpcPrefs = (url: string, m: string) => url.includes('/rest/v1/rpc/get_user_prompt_prefs') && m === 'POST';
const isPrefsExistingCheck = (url: string, m: string) =>
  url.includes('/rest/v1/autopilot_prompt_prefs') && url.includes('select=id') && m === 'GET';
const isPrefsPatch = (url: string, m: string) => url.includes('/rest/v1/autopilot_prompt_prefs') && m === 'PATCH';
const isPrefsInsert = (url: string, m: string) =>
  url.includes('/rest/v1/autopilot_prompt_prefs') && !url.includes('?') && m === 'POST';
const isMatchesDaily = (url: string, m: string) => url.includes('/rest/v1/matches_daily') && m === 'GET';
const isPromptsExistingCheck = (url: string, m: string) =>
  url.includes('/rest/v1/autopilot_prompts') && url.includes('match_id=in.') && m === 'GET';
const isPromptsToday = (url: string, m: string) =>
  url.includes('/rest/v1/autopilot_prompts') && url.includes('prompt_date=eq.') && m === 'GET';
const isPromptGetById = (url: string, m: string) =>
  url.includes('/rest/v1/autopilot_prompts') && url.includes('id=eq.') && url.includes('select=*') && m === 'GET';
const isPromptInsert = (url: string, m: string) =>
  url.includes('/rest/v1/autopilot_prompts') && !url.includes('?') && m === 'POST';
const isPromptPatch = (url: string, m: string) => url.includes('/rest/v1/autopilot_prompts') && m === 'PATCH';
const isOasisEvents = (url: string) => url.includes('/rest/v1/oasis_events');

function defaultPrefsRow(overrides: Record<string, any> = {}) {
  return {
    id: 'pref-1',
    enabled: true,
    max_prompts_per_day: 5,
    quiet_hours: null,
    allow_types: ['person', 'group', 'event', 'service'],
    prompts_today: 0,
    in_quiet_hours: false,
    ...overrides,
  };
}

function match(overrides: Record<string, any> = {}) {
  return {
    id: 'match-1',
    tenant_id: 'tenant-1',
    user_id: 'user-1',
    match_date: '2026-07-28',
    match_type: 'person',
    target_id: 'target-1',
    target_title: 'Jane Doe',
    score: 88,
    topic: 'Wellness',
    state: 'suggested',
    created_at: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getPromptPrefs
// ---------------------------------------------------------------------------

describe('getPromptPrefs', () => {
  it('returns ok:false without calling fetch when Supabase is not configured', async () => {
    const { getPromptPrefs } = freshModule({ missingUrl: true });
    const { fn } = buildFetch([]);
    global.fetch = fn as any;

    const result = await getPromptPrefs('t1', 'u1');

    expect(result).toEqual({ ok: false, error: 'Supabase not configured' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns default prefs when the RPC call fails', async () => {
    const { getPromptPrefs } = freshModule();
    const { fn } = buildFetch([{ when: isRpcPrefs, res: textRes('function not found', false, 404) }]);
    global.fetch = fn as any;

    const result = await getPromptPrefs('t1', 'u1');

    expect(result).toEqual({
      ok: true,
      prefs: {
        id: null,
        enabled: true,
        max_prompts_per_day: 5,
        quiet_hours: null,
        allow_types: ['person', 'group', 'event', 'service'],
        prompts_today: 0,
        in_quiet_hours: false,
      },
    });
  });

  it('returns default prefs when the RPC returns no row', async () => {
    const { getPromptPrefs } = freshModule();
    const { fn } = buildFetch([{ when: isRpcPrefs, res: jsonRes([]) }]);
    global.fetch = fn as any;

    const result = await getPromptPrefs('t1', 'u1');

    expect(result.ok).toBe(true);
    expect(result.prefs?.id).toBeNull();
    expect(result.prefs?.max_prompts_per_day).toBe(5);
  });

  it('maps a returned row to PromptPrefs, defaulting allow_types/prompts_today/in_quiet_hours when absent', async () => {
    const { getPromptPrefs } = freshModule();
    const { fn } = buildFetch([
      {
        when: isRpcPrefs,
        res: jsonRes([{ id: 'pref-9', enabled: false, max_prompts_per_day: 3, quiet_hours: { from: '22:00', to: '08:00' } }]),
      },
    ]);
    global.fetch = fn as any;

    const result = await getPromptPrefs('t1', 'u1');

    expect(result).toEqual({
      ok: true,
      prefs: {
        id: 'pref-9',
        enabled: false,
        max_prompts_per_day: 3,
        quiet_hours: { from: '22:00', to: '08:00' },
        allow_types: ['person', 'group', 'event', 'service'],
        prompts_today: 0,
        in_quiet_hours: false,
      },
    });
  });

  it('accepts a single-object RPC response (non-array)', async () => {
    const { getPromptPrefs } = freshModule();
    const { fn } = buildFetch([{ when: isRpcPrefs, res: jsonRes(defaultPrefsRow({ id: 'pref-solo' })) }]);
    global.fetch = fn as any;

    const result = await getPromptPrefs('t1', 'u1');

    expect(result.prefs?.id).toBe('pref-solo');
  });

  it('returns ok:false with a generic error when fetch throws', async () => {
    const { getPromptPrefs } = freshModule();
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as any;

    const result = await getPromptPrefs('t1', 'u1');

    expect(result).toEqual({ ok: false, error: 'Failed to get preferences' });
  });
});

// ---------------------------------------------------------------------------
// updatePromptPrefs
// ---------------------------------------------------------------------------

describe('updatePromptPrefs', () => {
  it('returns ok:false without calling fetch when Supabase is not configured', async () => {
    const { updatePromptPrefs } = freshModule({ missingKey: true });
    const { fn } = buildFetch([]);
    global.fetch = fn as any;

    const result = await updatePromptPrefs('t1', 'u1', { enabled: false });

    expect(result).toEqual({ ok: false, error: 'Supabase not configured' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('PATCHes existing prefs with only the provided fields + updated_at, then emits an event and re-fetches', async () => {
    const { updatePromptPrefs } = freshModule();
    const { fn, calls } = buildFetch([
      { when: isPrefsExistingCheck, res: jsonRes([{ id: 'pref-1' }]) },
      { when: isPrefsPatch, res: jsonRes([defaultPrefsRow({ enabled: false })]) },
      { when: isRpcPrefs, res: jsonRes([defaultPrefsRow({ enabled: false })]) },
    ]);
    global.fetch = fn as any;

    const result = await updatePromptPrefs('t1', 'u1', { enabled: false });

    const patchCall = calls.find((c) => isPrefsPatch(c.url, (c.init.method || '').toUpperCase()));
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall!.init.body);
    expect(body.enabled).toBe(false);
    expect(typeof body.updated_at).toBe('string');
    expect(body).not.toHaveProperty('max_prompts_per_day');
    expect(body).not.toHaveProperty('quiet_hours');
    expect(body).not.toHaveProperty('allow_types');

    const eventCall = calls.find((c) => isOasisEvents(c.url));
    expect(eventCall).toBeDefined();
    const eventBody = JSON.parse(eventCall!.init.body);
    expect(eventBody.topic).toBe('autopilot.prefs.updated');

    expect(result.ok).toBe(true);
    expect(result.prefs?.enabled).toBe(false);
  });

  it('INSERTs new prefs with defaults filled in when no row exists yet', async () => {
    const { updatePromptPrefs } = freshModule();
    const { fn, calls } = buildFetch([
      { when: isPrefsExistingCheck, res: jsonRes([]) },
      { when: isPrefsInsert, res: jsonRes([defaultPrefsRow()]) },
      { when: isRpcPrefs, res: jsonRes([defaultPrefsRow()]) },
    ]);
    global.fetch = fn as any;

    await updatePromptPrefs('t1', 'u1', { max_prompts_per_day: 8 });

    const insertCall = calls.find((c) => isPrefsInsert(c.url, (c.init.method || '').toUpperCase()));
    expect(insertCall).toBeDefined();
    const body = JSON.parse(insertCall!.init.body);
    expect(body.tenant_id).toBe('t1');
    expect(body.user_id).toBe('u1');
    expect(body.max_prompts_per_day).toBe(8); // provided value used
    expect(body.enabled).toBe(true); // default
    expect(body.quiet_hours).toBeNull(); // default
    expect(body.allow_types).toEqual(['person', 'group', 'event', 'service']); // default
    expect(typeof body.id).toBe('string');
    expect(typeof body.created_at).toBe('string');
  });

  it('returns ok:false and does not emit an event when the write fails', async () => {
    const { updatePromptPrefs } = freshModule();
    const { fn, calls } = buildFetch([
      { when: isPrefsExistingCheck, res: jsonRes([{ id: 'pref-1' }]) },
      { when: isPrefsPatch, res: textRes('server error', false, 500) },
    ]);
    global.fetch = fn as any;

    const result = await updatePromptPrefs('t1', 'u1', { enabled: true });

    expect(result).toEqual({ ok: false, error: 'Failed to update preferences' });
    expect(calls.some((c) => isOasisEvents(c.url))).toBe(false);
    expect(calls.some((c) => isRpcPrefs(c.url, (c.init.method || '').toUpperCase()))).toBe(false);
  });

  it('returns ok:false with a generic error when fetch throws', async () => {
    const { updatePromptPrefs } = freshModule();
    global.fetch = jest.fn().mockRejectedValue(new Error('boom')) as any;

    const result = await updatePromptPrefs('t1', 'u1', { enabled: true });

    expect(result).toEqual({ ok: false, error: 'Failed to update preferences' });
  });
});

// ---------------------------------------------------------------------------
// generatePrompts
// ---------------------------------------------------------------------------

describe('generatePrompts — gates', () => {
  it('returns ok:false without calling fetch when Supabase is not configured', async () => {
    const { generatePrompts } = freshModule({ missingUrl: true });
    const { fn } = buildFetch([]);
    global.fetch = fn as any;

    const result = await generatePrompts('t1', 'u1');

    expect(result).toEqual({ ok: false, generated: 0, error: 'Supabase not configured' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns ok:false when preferences cannot be fetched', async () => {
    const { generatePrompts } = freshModule();
    global.fetch = jest.fn().mockRejectedValue(new Error('down')) as any;

    // getPromptPrefs itself swallows the throw and returns ok:false only if
    // fetch throws inside it — but generatePrompts wraps prefsResult.ok check.
    const result = await generatePrompts('t1', 'u1');
    expect(result.ok).toBe(false);
    expect(result.generated).toBe(0);
  });

  it('skips generation when prompts are disabled, reporting remaining:0', async () => {
    const { generatePrompts } = freshModule();
    const { fn, calls } = buildFetch([{ when: isRpcPrefs, res: jsonRes([defaultPrefsRow({ enabled: false, prompts_today: 2 })]) }]);
    global.fetch = fn as any;

    const result = await generatePrompts('t1', 'u1');

    expect(result).toEqual({
      ok: true,
      generated: 0,
      prompts: [],
      rate_limit_info: { max_per_day: 5, used_today: 2, remaining: 0 },
    });
    expect(calls.some((c) => isMatchesDaily(c.url, 'GET'))).toBe(false);
  });

  it('skips generation when the server reports in_quiet_hours=true, reporting the true remaining count', async () => {
    const { generatePrompts } = freshModule();
    const { fn, calls } = buildFetch([
      { when: isRpcPrefs, res: jsonRes([defaultPrefsRow({ in_quiet_hours: true, prompts_today: 1, max_prompts_per_day: 5 })]) },
    ]);
    global.fetch = fn as any;

    const result = await generatePrompts('t1', 'u1');

    expect(result.generated).toBe(0);
    expect(result.rate_limit_info).toEqual({ max_per_day: 5, used_today: 1, remaining: 4 });
    expect(calls.some((c) => isMatchesDaily(c.url, 'GET'))).toBe(false);
  });

  it('skips generation when the local quiet_hours window covers the current time', async () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 6, 28, 12, 0, 0)); // local noon
    try {
      const { generatePrompts } = freshModule();
      const { fn, calls } = buildFetch([
        { when: isRpcPrefs, res: jsonRes([defaultPrefsRow({ quiet_hours: { from: '00:00', to: '23:59' } })]) },
      ]);
      global.fetch = fn as any;

      const result = await generatePrompts('t1', 'u1');

      expect(result.generated).toBe(0);
      expect(calls.some((c) => isMatchesDaily(c.url, 'GET'))).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips generation when the rate limit is already reached', async () => {
    const { generatePrompts } = freshModule();
    const { fn, calls } = buildFetch([
      { when: isRpcPrefs, res: jsonRes([defaultPrefsRow({ prompts_today: 5, max_prompts_per_day: 5 })]) },
    ]);
    global.fetch = fn as any;

    const result = await generatePrompts('t1', 'u1');

    expect(result).toEqual({
      ok: true,
      generated: 0,
      prompts: [],
      rate_limit_info: { max_per_day: 5, used_today: 5, remaining: 0 },
    });
    expect(calls.some((c) => isMatchesDaily(c.url, 'GET'))).toBe(false);
  });

  it('returns generated:0 gracefully when the matches_daily query fails (table may not exist yet)', async () => {
    const { generatePrompts } = freshModule();
    const { fn } = buildFetch([
      { when: isRpcPrefs, res: jsonRes([defaultPrefsRow()]) },
      { when: isMatchesDaily, res: textRes('relation does not exist', false, 404) },
    ]);
    global.fetch = fn as any;

    const result = await generatePrompts('t1', 'u1');

    expect(result.ok).toBe(true);
    expect(result.generated).toBe(0);
    expect(result.prompts).toEqual([]);
  });
});

describe('generatePrompts — dedup + insertion', () => {
  it('filters out matches that already have a prompt for their match_id', async () => {
    const m1 = match({ id: 'match-1' });
    const m2 = match({ id: 'match-2', target_title: 'Second' });
    const { generatePrompts } = freshModule();
    const { fn, calls } = buildFetch([
      { when: isRpcPrefs, res: jsonRes([defaultPrefsRow()]) },
      { when: isMatchesDaily, res: jsonRes([m1, m2]) },
      { when: isPromptsExistingCheck, res: jsonRes([{ match_id: 'match-1' }]) },
      { when: isPromptInsert, res: jsonRes({}) },
    ]);
    global.fetch = fn as any;

    const result = await generatePrompts('t1', 'u1');

    expect(result.generated).toBe(1);
    const insertCalls = calls.filter((c) => isPromptInsert(c.url, (c.init.method || '').toUpperCase()));
    expect(insertCalls).toHaveLength(1);
    const body = JSON.parse(insertCalls[0].init.body);
    expect(body.match_id).toBe('match-2');
  });

  it('assembles the message and action verb per match type, and inserts every match when none is filtered', async () => {
    const cases: Array<[string, string]> = [
      ['person', 'connect with'],
      ['group', 'join'],
      ['event', 'attend'],
      ['service', 'book'],
      ['product', 'check out'],
      ['location', 'visit'],
    ];
    const matches = cases.map(([type], i) => match({ id: `match-${i}`, match_type: type, target_title: `Target ${i}`, topic: 'Topic' }));

    const { generatePrompts } = freshModule();
    const { fn, calls } = buildFetch([
      { when: isRpcPrefs, res: jsonRes([defaultPrefsRow({ allow_types: cases.map((c) => c[0]) as any, max_prompts_per_day: 10 })]) },
      { when: isMatchesDaily, res: jsonRes(matches) },
      { when: isPromptsExistingCheck, res: jsonRes([]) },
      { when: isPromptInsert, res: jsonRes({}) },
    ]);
    global.fetch = fn as any;

    const result = await generatePrompts('t1', 'u1', { score_threshold: 75, limit: 10 });

    expect(result.generated).toBe(6);
    const insertCalls = calls.filter((c) => isPromptInsert(c.url, (c.init.method || '').toUpperCase()));
    expect(insertCalls).toHaveLength(6);
    insertCalls.forEach((c, i) => {
      const body = JSON.parse(c.init.body);
      const [type, verb] = cases[i];
      expect(body.title).toBe(`New ${type} suggestion`);
      expect(body.message).toBe(`You're aligned with **Topic**. Want to **${verb}**: **Target ${i}**?`);
      expect(body.actions).toEqual([
        { key: 'yes', label: 'Yes' },
        { key: 'not_now', label: 'Not now' },
        { key: 'options', label: 'See options' },
      ]);
      expect(body.state).toBe('shown');
    });
  });

  it('emits a prompt.shown event per successful insert and a prompts.generated aggregate event', async () => {
    const { generatePrompts } = freshModule();
    const { fn, calls } = buildFetch([
      { when: isRpcPrefs, res: jsonRes([defaultPrefsRow()]) },
      { when: isMatchesDaily, res: jsonRes([match()]) },
      { when: isPromptsExistingCheck, res: jsonRes([]) },
      { when: isPromptInsert, res: jsonRes({}) },
    ]);
    global.fetch = fn as any;

    await generatePrompts('t1', 'u1');

    const eventCalls = calls.filter((c) => isOasisEvents(c.url)).map((c) => JSON.parse(c.init.body).topic);
    expect(eventCalls).toEqual(['autopilot.prompt.shown', 'autopilot.prompts.generated']);
  });

  it('does not push a failed insert into the result and does not emit any event for it', async () => {
    const { generatePrompts } = freshModule();
    const { fn, calls } = buildFetch([
      { when: isRpcPrefs, res: jsonRes([defaultPrefsRow()]) },
      { when: isMatchesDaily, res: jsonRes([match()]) },
      { when: isPromptsExistingCheck, res: jsonRes([]) },
      { when: isPromptInsert, res: textRes('insert failed', false, 500) },
    ]);
    global.fetch = fn as any;

    const result = await generatePrompts('t1', 'u1');

    expect(result.generated).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(calls.some((c) => isOasisEvents(c.url))).toBe(false);
  });

  it('reports rate_limit_info with used_today/remaining accounting for the newly generated prompts', async () => {
    const { generatePrompts } = freshModule();
    const { fn } = buildFetch([
      { when: isRpcPrefs, res: jsonRes([defaultPrefsRow({ prompts_today: 2, max_prompts_per_day: 5 })]) },
      { when: isMatchesDaily, res: jsonRes([match()]) },
      { when: isPromptsExistingCheck, res: jsonRes([]) },
      { when: isPromptInsert, res: jsonRes({}) },
    ]);
    global.fetch = fn as any;

    const result = await generatePrompts('t1', 'u1');

    expect(result.rate_limit_info).toEqual({ max_per_day: 5, used_today: 3, remaining: 2 });
  });

  it('returns ok:false with a generic error when an unexpected exception occurs', async () => {
    const { generatePrompts } = freshModule();
    const { fn } = buildFetch([
      { when: isRpcPrefs, res: jsonRes([defaultPrefsRow()]) },
      {
        when: isMatchesDaily,
        res: () => {
          throw new Error('unexpected');
        },
      },
    ]);
    global.fetch = fn as any;

    const result = await generatePrompts('t1', 'u1');

    expect(result).toEqual({ ok: false, generated: 0, error: 'Failed to generate prompts' });
  });
});

// ---------------------------------------------------------------------------
// getTodayPrompts
// ---------------------------------------------------------------------------

describe('getTodayPrompts', () => {
  it('returns a default ok:false response without calling fetch when not configured', async () => {
    const { getTodayPrompts } = freshModule({ missingUrl: true });
    const { fn } = buildFetch([]);
    global.fetch = fn as any;

    const result = await getTodayPrompts('t1', 'u1');

    expect(result).toEqual({
      ok: false,
      prompts: [],
      rate_limit_info: { max_per_day: 5, used_today: 0, remaining: 5, in_quiet_hours: false },
      error: 'Supabase not configured',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('falls back to prompts:[] with prefs.max_prompts_per_day remaining when the prompts query fails', async () => {
    const { getTodayPrompts } = freshModule();
    const { fn } = buildFetch([
      { when: isRpcPrefs, res: jsonRes([defaultPrefsRow({ max_prompts_per_day: 7 })]) },
      { when: isPromptsToday, res: textRes('server error', false, 500) },
    ]);
    global.fetch = fn as any;

    const result = await getTodayPrompts('t1', 'u1');

    expect(result).toEqual({
      ok: true,
      prompts: [],
      rate_limit_info: { max_per_day: 7, used_today: 0, remaining: 7, in_quiet_hours: false },
    });
  });

  it('returns the prompts list with used_today = prompts.length and remaining floored at 0', async () => {
    const promptRows = [
      { id: 'p1', title: 'A' },
      { id: 'p2', title: 'B' },
      { id: 'p3', title: 'C' },
    ];
    const { getTodayPrompts } = freshModule();
    const { fn } = buildFetch([
      { when: isRpcPrefs, res: jsonRes([defaultPrefsRow({ max_prompts_per_day: 2, in_quiet_hours: true })]) },
      { when: isPromptsToday, res: jsonRes(promptRows) },
    ]);
    global.fetch = fn as any;

    const result = await getTodayPrompts('t1', 'u1');

    expect(result.ok).toBe(true);
    expect(result.prompts).toEqual(promptRows);
    // 3 prompts vs max 2 -> remaining floors at 0, not negative.
    expect(result.rate_limit_info).toEqual({ max_per_day: 2, used_today: 3, remaining: 0, in_quiet_hours: true });
  });

  it('returns a default ok:false response when fetch throws', async () => {
    const { getTodayPrompts } = freshModule();
    global.fetch = jest.fn().mockRejectedValue(new Error('down')) as any;

    const result = await getTodayPrompts('t1', 'u1');

    expect(result).toEqual({
      ok: false,
      prompts: [],
      rate_limit_info: { max_per_day: 5, used_today: 0, remaining: 5, in_quiet_hours: false },
      error: 'Failed to get prompts',
    });
  });
});

// ---------------------------------------------------------------------------
// executePromptAction
// ---------------------------------------------------------------------------

function storedPrompt(overrides: Record<string, any> = {}) {
  return {
    id: 'prompt-1',
    tenant_id: 't1',
    user_id: 'u1',
    state: 'shown',
    title: 'New person suggestion',
    match_id: 'match-1',
    match_type: 'person',
    target_id: 'target-1',
    target_type: 'person',
    topic: 'Wellness',
    ...overrides,
  };
}

describe('executePromptAction', () => {
  it('returns ok:false without calling fetch when not configured', async () => {
    const { executePromptAction } = freshModule({ missingKey: true });
    const { fn } = buildFetch([]);
    global.fetch = fn as any;

    const result = await executePromptAction('t1', 'u1', 'prompt-1', { action: 'yes' });

    expect(result).toEqual({ ok: false, prompt_id: 'prompt-1', action: 'yes', new_state: 'shown', error: 'Supabase not configured' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns "Failed to get prompt" when the lookup request itself fails', async () => {
    const { executePromptAction } = freshModule();
    const { fn } = buildFetch([{ when: isPromptGetById, res: textRes('error', false, 500) }]);
    global.fetch = fn as any;

    const result = await executePromptAction('t1', 'u1', 'prompt-1', { action: 'not_now' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Failed to get prompt');
  });

  it('returns "Prompt not found" when the lookup returns no rows', async () => {
    const { executePromptAction } = freshModule();
    const { fn } = buildFetch([{ when: isPromptGetById, res: jsonRes([]) }]);
    global.fetch = fn as any;

    const result = await executePromptAction('t1', 'u1', 'prompt-1', { action: 'not_now' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Prompt not found');
  });

  it('"yes" on a person target: state->accepted, action_result=connection_request, PATCHes state, emits accepted/success event', async () => {
    const { executePromptAction } = freshModule();
    const { fn, calls } = buildFetch([
      { when: isPromptGetById, res: jsonRes([storedPrompt()]) },
      { when: isPromptPatch, res: jsonRes({}) },
    ]);
    global.fetch = fn as any;

    const result = await executePromptAction('t1', 'u1', 'prompt-1', { action: 'yes' });

    expect(result.ok).toBe(true);
    expect(result.new_state).toBe('accepted');
    expect(result.action_result).toEqual({
      type: 'connection_request',
      target_id: 'target-1',
      target_type: 'person',
      success: true,
      message: 'Action connection_request recorded',
    });

    const patchCall = calls.find((c) => isPromptPatch(c.url, (c.init.method || '').toUpperCase()));
    expect(patchCall).toBeDefined();
    const patchBody = JSON.parse(patchCall!.init.body);
    expect(patchBody.state).toBe('accepted');
    expect(patchBody.action_taken).toBe('yes');
    expect(typeof patchBody.actioned_at).toBe('string');

    const eventCall = calls.find((c) => isOasisEvents(c.url));
    const eventBody = JSON.parse(eventCall!.init.body);
    expect(eventBody.topic).toBe('autopilot.prompt.action.accepted');
    expect(eventBody.status).toBe('success');
  });

  it.each([
    ['group', 'group_join'],
    ['event', 'event_rsvp'],
    ['service', 'interest_saved'],
    ['product', 'interest_saved'],
    ['location', 'interest_saved'],
  ])('"yes" on a %s target maps to action_result.type=%s', async (targetType, expectedType) => {
    const { executePromptAction } = freshModule();
    const { fn } = buildFetch([
      { when: isPromptGetById, res: jsonRes([storedPrompt({ target_type: targetType, match_type: targetType })]) },
      { when: isPromptPatch, res: jsonRes({}) },
    ]);
    global.fetch = fn as any;

    const result = await executePromptAction('t1', 'u1', 'prompt-1', { action: 'yes' });

    expect(result.action_result?.type).toBe(expectedType);
    expect(result.action_result?.success).toBe(true);
  });

  it('"yes" with no target_id returns a failed interest_saved result without throwing', async () => {
    const { executePromptAction } = freshModule();
    const { fn } = buildFetch([
      { when: isPromptGetById, res: jsonRes([storedPrompt({ target_id: null })]) },
      { when: isPromptPatch, res: jsonRes({}) },
    ]);
    global.fetch = fn as any;

    const result = await executePromptAction('t1', 'u1', 'prompt-1', { action: 'yes' });

    expect(result.action_result).toEqual({
      type: 'interest_saved',
      target_id: '',
      target_type: 'person',
      success: false,
      message: 'No target specified',
    });
  });

  it('"not_now": state->dismissed, no action_result, PATCHes state, emits dismissed/info event', async () => {
    const { executePromptAction } = freshModule();
    const { fn, calls } = buildFetch([
      { when: isPromptGetById, res: jsonRes([storedPrompt()]) },
      { when: isPromptPatch, res: jsonRes({}) },
    ]);
    global.fetch = fn as any;

    const result = await executePromptAction('t1', 'u1', 'prompt-1', { action: 'not_now' });

    expect(result.new_state).toBe('dismissed');
    expect(result.action_result).toBeUndefined();
    const patchCall = calls.find((c) => isPromptPatch(c.url, (c.init.method || '').toUpperCase()));
    expect(JSON.parse(patchCall!.init.body).state).toBe('dismissed');
    const eventBody = JSON.parse(calls.find((c) => isOasisEvents(c.url))!.init.body);
    expect(eventBody.topic).toBe('autopilot.prompt.action.dismissed');
    expect(eventBody.status).toBe('info');
  });

  it('"options": state unchanged, no PATCH issued, returns candidates from matches_daily, emits options_opened event', async () => {
    const { executePromptAction } = freshModule();
    const candidates = [match({ id: 'c1', target_title: 'Cand One', score: 90 }), match({ id: 'c2', target_title: 'Cand Two', score: 80 })];
    const { fn, calls } = buildFetch([
      { when: isPromptGetById, res: jsonRes([storedPrompt()]) },
      { when: isMatchesDaily, res: jsonRes(candidates) },
    ]);
    global.fetch = fn as any;

    const result = await executePromptAction('t1', 'u1', 'prompt-1', { action: 'options' });

    expect(result.new_state).toBe('shown'); // unchanged from stored prompt
    expect(result.options).toEqual([
      { id: 'c1', type: 'person', title: 'Cand One', score: 90, topic: 'Wellness' },
      { id: 'c2', type: 'person', title: 'Cand Two', score: 80, topic: 'Wellness' },
    ]);
    expect(calls.some((c) => isPromptPatch(c.url, (c.init.method || '').toUpperCase()))).toBe(false);
    const eventBody = JSON.parse(calls.find((c) => isOasisEvents(c.url))!.init.body);
    expect(eventBody.topic).toBe('autopilot.prompt.action.options_opened');
  });

  it('"options" returns [] when the candidates query fails, without throwing', async () => {
    const { executePromptAction } = freshModule();
    const { fn } = buildFetch([
      { when: isPromptGetById, res: jsonRes([storedPrompt()]) },
      { when: isMatchesDaily, res: textRes('error', false, 500) },
    ]);
    global.fetch = fn as any;

    const result = await executePromptAction('t1', 'u1', 'prompt-1', { action: 'options' });

    expect(result.ok).toBe(true);
    expect(result.options).toEqual([]);
  });

  it('still returns ok:true when the PATCH write fails (state update is best-effort)', async () => {
    const { executePromptAction } = freshModule();
    const { fn } = buildFetch([
      { when: isPromptGetById, res: jsonRes([storedPrompt()]) },
      { when: isPromptPatch, res: textRes('conflict', false, 409) },
    ]);
    global.fetch = fn as any;

    const result = await executePromptAction('t1', 'u1', 'prompt-1', { action: 'not_now' });

    expect(result.ok).toBe(true);
    expect(result.new_state).toBe('dismissed');
  });

  it('returns "Failed to execute action" when an unexpected exception occurs', async () => {
    const { executePromptAction } = freshModule();
    global.fetch = jest.fn().mockRejectedValue(new Error('down')) as any;

    const result = await executePromptAction('t1', 'u1', 'prompt-1', { action: 'yes' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Failed to execute action');
  });
});
