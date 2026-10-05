/**
 * VTID-04517 — the navigation dispatcher.
 *
 * The two existing voice tools keep their names (every
 * prompt and tool description refers to them) but run here:
 *
 *   navigate(question, intent)   → the registry resolver (nav-resolver.ts).
 *     intent "open"  + a clear match → opens it now.
 *     intent "where" + a clear match → says where it is and offers to open;
 *                                      nothing moves until the member agrees
 *                                      and the model calls navigate_to_screen.
 *     otherwise → candidates for the model to choose from or ask about, or
 *                 "nothing in the app matches".
 *   navigate_to_screen(screen_id) → openScreen(): the one place a screen is
 *     opened, with every gate (known screen, not disabled, allowed for this
 *     visitor, right viewport, not already there).
 *
 * The directive is the payload the web client already handles
 * (`orb_directive` / `navigate`, overlays as `?open=<marker>`), so the
 * WS/SSE post-processing in routes/orb-live.ts is unchanged.
 *
 * VTID-04846: nothing falls back to the legacy navigator any more. Screens
 * about one item open with the id a prior tool result handed the model; the
 * admin area refuses voice navigation (it has no registry screens); and when
 * the resolver cannot run (Titan unavailable) an exact screen name still
 * works and anything else is answered honestly instead of guessed.
 */
import type { OrbToolResult } from '../services/orb-tools-shared';
import { findScreenForRoute, getNavRegistry, isVoiceTarget, NavScreen, NavSurface, pageOf, screenSurface, screenText, surfaceForRoute } from './nav-registry';

export { findScreenForRoute, screenText };
import { candidateFor, isOpenableFor, isReachable, NavCandidate, NavResolveContext, routeFor } from './nav-resolver';
import { resolveScreenRequest } from './nav-service';

/**
 * VTID-04846 — the admin area has no screens Vitana can open by voice (the
 * registry describes the member app and the Command Hub). The legacy
 * navigator refused every screen there too; this says so up front. Every
 * other role area (BackOffice, professional, staff, …) is served by the
 * member app's screens, as it always was.
 */
export function isNavigationOffSurface(currentRoute: string | null | undefined): boolean {
  if (!currentRoute) return false;
  return currentRoute === '/admin' || currentRoute.startsWith('/admin/');
}

export function navigationOffResult(): OrbToolResult {
  return {
    ok: false,
    error: 'Screens cannot be opened by voice in the admin area. Tell the admin where to find what they asked for in the admin menu instead.',
  };
}

export interface NavCallContext {
  lang: string;
  isAnonymous: boolean;
  isMobile: boolean;
  currentRoute: string | null;
  sessionId: string | null;
  /** Tenant switch-offs from the Command Hub (none wired yet). */
  excluded?: ReadonlySet<string>;
  /**
   * VTID-04521: hold an offer so a bare "yes" on the next turn opens it
   * (the continuation bind consumes it). Best effort; never awaited for
   * correctness of the answer.
   */
  recordOffer?: (offer: { screen_id: string; title: string; route: string }) => Promise<void>;
  /**
   * VTID-04607: what the member actually said this turn (the live session's
   * transcript). The voice model often shortens the request it passes as
   * `question` ("pop up my wallet for a quick look" → "wallet"), which loses
   * exactly the words that pick a popup over a page or one tab over another.
   */
  memberWords?: string;
  /**
   * VTID-04814: the surface the session is on, when the caller knows it
   * (the widget declares it). Falls back to the current route.
   */
  surface?: NavSurface;
}

/** The surface a call is on: declared first, then the route. */
export function callSurface(c: Pick<NavCallContext, 'surface' | 'currentRoute'>): NavSurface {
  return c.surface ?? surfaceForRoute(c.currentRoute);
}

/** The member's words, when they add something to the model's question. */
export function memberWordsFor(question: string, memberWords: string | undefined): string | null {
  const w = (memberWords || '').replace(/\s+/g, ' ').trim();
  if (w.length < 3) return null;
  const tail = w.length > 300 ? w.slice(-300) : w;
  return tail.toLowerCase() === question.trim().toLowerCase() ? null : tail;
}

function resolveContext(c: NavCallContext): NavResolveContext {
  return {
    lang: c.lang,
    authenticated: !c.isAnonymous,
    // An unreported viewport filters nothing; only a known mobile session
    // gets mobile routes and mobile-only screens.
    viewport: c.isMobile ? 'mobile' : undefined,
    excluded: c.excluded,
    surface: callSurface(c),
  };
}

async function emit(type: 'orb.navigator.resolved' | 'orb.navigator.requested' | 'orb.navigator.blocked', status: 'info' | 'warning', message: string, payload: Record<string, unknown>) {
  const { emitOasisEvent } = await import('../services/oasis-event-service');
  emitOasisEvent({ vtid: 'VTID-04517', type, source: 'nav-dispatch', status, message, payload: { resolver: 'registry-v2', ...payload } }).catch(() => {});
}

/**
 * Look a screen up by id, retired id or alias (case-insensitive). With a
 * surface, aliases and invented ids only match that surface's screens, so
 * "DEVHUB.OASIS.EVENTS" never lands on the community Events page.
 */
export function findRegistryScreen(idOrAlias: string, surface?: NavSurface): NavScreen | null {
  const key = idOrAlias.trim();
  if (!key) return null;
  const all = getNavRegistry().registry.screens;
  const screens = surface ? all.filter((s) => screenSurface(s) === surface) : all;
  const upper = key.toUpperCase();
  const lower = key.toLowerCase();
  return (
    screens.find((s) => s.id === key || s.id === upper) ||
    screens.find((s) => (s.formerIds || []).some((f) => f === key || f === upper)) ||
    screens.find((s) => (s.aliases || []).some((a) => a.toLowerCase() === lower)) ||
    findByInventedIdTail(screens, key) ||
    null
  );
}

/**
 * VTID-04629 — the voice model sometimes invents an id in the registry's
 * shape ("COMM.NEWSFEED", "SOCIAL.CREATE_POST"). Its last segment is often
 * exactly an alias ("newsfeed", "create-post"); match that before treating
 * the id as unknown. Only whole-alias matches, so "SETTINGS.OVERVIEW"-style
 * tails never land on an unrelated screen.
 */
function findByInventedIdTail(screens: NavScreen[], key: string): NavScreen | null {
  const parts = key.split('.');
  if (parts.length < 2) return null;
  const tail = parts[parts.length - 1].toLowerCase();
  if (tail.length < 4) return null;
  const variants = new Set([tail, tail.replace(/_/g, '-'), tail.replace(/_/g, '')]);
  return screens.find((s) => (s.aliases || []).some((a) => variants.has(a.toLowerCase()))) || null;
}

/**
 * VTID-04521 — the registry screen a route belongs to (explain_feature hands
 * back a route; navigate_to_screen takes a screen id). Exact route first,
 * then the page (query stripped) among voice-reachable screens.
 */
export function findRegistryScreenByRoute(route: string | null | undefined): NavScreen | null {
  if (!route) return null;
  const screens = getNavRegistry().registry.screens.filter(isVoiceTarget);
  const exact = screens.find((s) => s.route === route || s.mobileRoute === route);
  if (exact) return exact;
  const page = pageOf(route);
  return screens.find((s) => s.route === page) || screens.find((s) => pageOf(s.route) === page) || null;
}

/** Screens that need an entity id (a member profile, one group) to open. */
export function needsEntity(s: NavScreen): boolean {
  return !!(s.params && s.params.length) || !!s.overlay?.param;
}

/**
 * VTID-04846 — the navigate_to_screen argument names that carry each
 * screen's route parameter. The tool schema predates the registry and names
 * some parameters after the old catalog's routes (groupId, match_id,
 * vitana_id); the registry param name itself always works too.
 */
const ENTITY_ARG_ALIASES: Record<string, Record<string, string[]>> = {
  'COMM.GROUP_DETAIL': { id: ['groupId', 'group_id'] },
  'INTENTS.MATCH_DETAIL': { id: ['match_id'] },
  'PROFILE.PUBLIC': { identifier: ['vitana_id'] },
  'PROFILE.WITH_MATCH': { identifier: ['vitana_id'] },
};

export type NavEntityArgs = Record<string, unknown>;

function entityArg(screen: NavScreen, param: string, args: NavEntityArgs): string | null {
  for (const name of [param, ...(ENTITY_ARG_ALIASES[screen.id]?.[param] || [])]) {
    const v = args[name];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim().replace(/^@/, '');
  }
  return null;
}

/** Fill a route template from the call's arguments; lists what is missing. */
export function fillEntityRoute(screen: NavScreen, template: string, args: NavEntityArgs): { route: string; missing: string[] } {
  const missing: string[] = [];
  const route = template.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (m, name: string) => {
    const v = entityArg(screen, name, args);
    if (v === null) {
      missing.push(name);
      return m;
    }
    return encodeURIComponent(v);
  });
  return { route, missing };
}

/**
 * Open one screen — every gate in one place. Returns the same result shape
 * as the legacy tool_navigate_to_screen so orb-live's dispatch is unchanged.
 */
export async function openScreen(
  screenId: string,
  reason: string,
  c: NavCallContext,
  opts: { keepOrbOpen?: boolean; entityArgs?: NavEntityArgs } = {},
): Promise<OrbToolResult> {
  const ctx = resolveContext(c);
  const screen = findRegistryScreen(screenId, ctx.surface) || findRegistryScreen(screenId);
  const block = async (kind: string, error: string): Promise<OrbToolResult> => {
    await emit('orb.navigator.blocked', 'warning', `open ${screenId}: ${kind}`, { session_id: c.sessionId, attempted_screen_id: screenId, error_kind: kind });
    return { ok: false, error };
  };
  if (!screen) {
    return block('unknown_screen', `There is no screen "${screenId}". Call navigate with the member's words to find the right one.`);
  }
  if (screen.disabled) {
    return block('disabled', `The ${screen.i18n.en.title} screen cannot be opened by voice right now. Tell the member where to find it instead.`);
  }
  const entity = needsEntity(screen);
  if (screenSurface(screen) !== ctx.surface) {
    return block('wrong_surface', ctx.surface === 'command-hub'
      ? `${screen.i18n.en.title} is in the member app, not the Command Hub. Call navigate with what the developer asked for to find the Command Hub screen.`
      : `${screen.i18n.en.title} is a Command Hub screen and cannot be opened in the member app. Answer in voice instead.`);
  }
  if (!(entity ? isOpenableFor(screen, ctx) : isReachable(screen, ctx))) {
    const kind = !ctx.authenticated && screen.access !== 'public' ? 'anonymous_blocked' : ctx.excluded?.has(screen.id) ? 'tenant_excluded' : 'viewport_blocked';
    const why = kind === 'anonymous_blocked'
      ? 'The visitor is not signed in; this screen is for members. Offer to help them sign up instead.'
      : kind === 'tenant_excluded'
        ? 'This screen is switched off for this community.'
        : 'This screen is not available on the device the member is using.';
    return block(kind, why);
  }

  // VTID-04846: screens about one item get its id from the call's arguments
  // (a prior tool result handed it to the model). Never guessed.
  let baseRoute = routeFor(screen, ctx.viewport);
  if (entity) {
    const filled = fillEntityRoute(screen, baseRoute, opts.entityArgs || {});
    const missingOverlay = screen.overlay?.param && entityArg(screen, screen.overlay.param, opts.entityArgs || {}) === null ? [screen.overlay.param] : [];
    const missing = [...filled.missing, ...missingOverlay];
    if (missing.length) {
      return block('missing_param', `${screen.i18n.en.title} is about one specific item and needs ${missing.join(', ')} from a prior tool result. Get it first (never invent one), then call navigate_to_screen again.`);
    }
    baseRoute = filled.route;
  }
  const isOverlay = !!screen.overlay;
  let route = baseRoute;
  if (isOverlay && screen.overlay?.marker) {
    const q = new URLSearchParams({ open: screen.overlay.marker });
    if (screen.overlay.param) q.set(screen.overlay.param, entityArg(screen, screen.overlay.param, opts.entityArgs || {}) as string);
    route = `${baseRoute}${baseRoute.includes('?') ? '&' : '?'}${q.toString()}`;
  }
  const basePath = pageOf(baseRoute);
  const title = candidateFor(screen, 1, ctx).title;

  // Already there: only when the member is on exactly this page with no tab
  // or section to switch to (current_route carries no query string).
  if (!isOverlay && c.currentRoute && !baseRoute.includes('?') && pageOf(c.currentRoute) === basePath) {
    await emit('orb.navigator.blocked', 'info', `already on ${basePath}`, { session_id: c.sessionId, attempted_screen_id: screen.id, error_kind: 'already_there' });
    return {
      ok: true,
      result: { screen_id: screen.id, route: baseRoute, already_there: true, entry_kind: 'route' },
      text: `The member is already on the ${title} screen. Answer from what is on it, or suggest a related screen.`,
    };
  }

  const directive = {
    type: 'orb_directive',
    directive: 'navigate',
    screen_id: screen.id,
    route,
    title,
    reason: reason || 'navigate_to_screen tool call',
    entry_kind: isOverlay ? 'overlay' : 'route',
    vtid: 'VTID-04517',
    // VTID-04521: speak first, then navigate. The widget holds the directive
    // until the reply has played out, so the member hears where they are
    // going, and it reports the outcome back as nav_result.
    after_speech: true,
    ...(opts.keepOrbOpen ? { keep_orb_open: true } : {}),
  };
  await emit('orb.navigator.requested', 'info', `open ${screen.id} (${route})`, {
    session_id: c.sessionId, screen_id: screen.id, route, entry_kind: directive.entry_kind, reason: directive.reason, is_anonymous: c.isAnonymous,
  });
  return {
    ok: true,
    result: { screen_id: screen.id, route, base_route: basePath, title, entry_kind: directive.entry_kind, directive },
    text: isOverlay
      ? `${title} opens as a panel on the current screen as soon as you finish this sentence. Say one short sentence about it; the member stays where they are and the conversation carries on.`
      : `${title} opens as soon as you finish speaking. Say one short sentence that you are taking them there, then stop.`,
  };
}

/** Record the offered screen so the continuation bind can open it on "yes". */
async function holdOffer(c: NavCallContext, screenId: string | undefined): Promise<void> {
  if (!c.recordOffer || !screenId) return;
  const screen = findRegistryScreen(screenId, callSurface(c));
  if (!screen || !isVoiceTarget(screen)) return;
  const ctx = resolveContext(c);
  try {
    await c.recordOffer({ screen_id: screen.id, title: candidateFor(screen, 1, ctx).title, route: routeFor(screen, ctx.viewport) });
  } catch {
    // Holding the offer is a convenience; the model can still call navigate_to_screen.
  }
}

function describe(cands: NavCandidate[]): string {
  return cands.map((x) => `- ${x.screen_id}: "${x.title}"${x.shows ? ` — ${x.shows}` : ''}`).join('\n');
}

export type NavIntent = 'open' | 'where';

function normName(text: string): string {
  return text.toLowerCase().replace(/[-_]+/g, ' ').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * VTID-04846 — when the embedding resolver cannot run, a request that is
 * exactly one screen's name (title, alias or phrasing, in the member's
 * language or English) still finds it. Anything looser is not guessed.
 */
export function exactNameMatch(text: string, ctx: NavResolveContext): NavScreen | null {
  const q = normName(text);
  if (q.length < 3) return null;
  const lang = (ctx.lang || 'en').split('-')[0].toLowerCase();
  const hits = new Set<NavScreen>();
  for (const s of getNavRegistry().registry.screens) {
    if (!isReachable(s, ctx)) continue;
    const names = [...(s.aliases || [])];
    for (const l of new Set([lang, 'en'])) {
      const t = s.i18n[l];
      if (t) names.push(t.title, ...(t.phrasings || []));
    }
    if (names.some((n) => n && normName(n) === q)) hits.add(s);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/** The free-text path: the registry resolver, every time. */
export async function navigateByRequest(
  question: string,
  intent: NavIntent,
  c: NavCallContext,
): Promise<OrbToolResult> {
  const started = Date.now();
  // VTID-04607: the member's own words first; the model's question only
  // when those match nothing (a bare "yes, open it" carries no screen).
  const words = memberWordsFor(question, c.memberWords);
  let r = words ? await resolveScreenRequest(words, resolveContext(c)) : null;
  let querySource: 'member_words' | 'model_question' = 'member_words';
  if (!r || r.kind === 'none' || r.kind === 'unavailable') {
    r = await resolveScreenRequest(question, resolveContext(c));
    querySource = 'model_question';
  }
  const base = {
    session_id: c.sessionId, question, intent, lang: c.lang, is_anonymous: c.isAnonymous, is_mobile: c.isMobile,
    current_route: c.currentRoute, ms_elapsed: Date.now() - started,
    query_source: querySource, ...(words ? { member_words: words } : {}),
  };
  if (r.kind === 'unavailable') {
    const ctx = resolveContext(c);
    const named = (words ? exactNameMatch(words, ctx) : null) || exactNameMatch(question, ctx);
    await emit('orb.navigator.resolved', 'warning', `resolver unavailable: ${r.reason}`, {
      ...base, kind: 'unavailable', reason: r.reason, exact_name_match: named?.id ?? null,
    });
    if (!named) {
      return {
        ok: true,
        result: { decision: 'unavailable', candidates: [] },
        text: 'SCREEN LOOKUP UNAVAILABLE: finding screens is not working at this moment. Do not navigate and do not guess a screen_id. Tell the member briefly, answer in voice, and suggest they ask again in a moment.',
      };
    }
    const cand = candidateFor(named, 1, ctx);
    r = { kind: 'match', screen: cand, candidates: [cand], top_score: 1, page_gap: 1 };
  }
  await emit('orb.navigator.resolved', 'info', `${r.kind}${r.kind === 'match' ? ` ${r.screen.screen_id}` : ''} (${intent})`, {
    ...base, kind: r.kind, top_score: r.top_score, page_gap: r.page_gap,
    candidates: r.candidates.map((x) => ({ screen_id: x.screen_id, score: x.score })),
  });

  if (r.kind === 'match' && intent === 'open') {
    return openScreen(r.screen.screen_id, question, c);
  }
  if (r.kind === 'match') {
    const s = r.screen;
    await holdOffer(c, s.screen_id);
    return {
      ok: true,
      result: { decision: 'offer', offer: { screen_id: s.screen_id, title: s.title }, candidates: r.candidates },
      text: [
        `FOUND: ${s.screen_id} — "${s.title}"${s.shows ? `: ${s.shows}` : ''}`,
        'The member asked WHERE this is, so do not open it yet. Tell them in one or two sentences what they will find there and where (use the title, never the route),',
        'then ask whether you should open it for them. If they say yes, call navigate_to_screen with',
        `screen_id "${s.screen_id}". If they say no, carry on the conversation.`,
      ].join('\n'),
    };
  }
  if (r.kind === 'ambiguous') {
    // Hold the best fit: a bare "yes" opens it; naming another candidate goes
    // through navigate_to_screen and supersedes this.
    if (intent === 'where') await holdOffer(c, r.candidates[0]?.screen_id);
    return {
      ok: true,
      result: { decision: 'ambiguous', candidates: r.candidates },
      text: [
        'POSSIBLE SCREENS (best first):',
        describe(r.candidates),
        intent === 'open'
          ? 'If one of these clearly fits what the member said, call navigate_to_screen with its screen_id now. If two fit equally, ask one short either/or question with their titles, then call navigate_to_screen with the id of their pick — never call navigate again for the same request.'
          : 'Tell the member where the best fit is and what it shows, then ask whether to open it; if two fit equally, ask which they mean. On a yes, call navigate_to_screen with that screen_id.',
        'If none of them fits, say you could not find a screen for that and answer in voice.',
      ].join('\n'),
    };
  }
  return {
    ok: true,
    result: { decision: 'none', candidates: [] },
    text: 'NO MATCHING SCREEN: nothing in the app matches this request. Do not navigate. Answer in voice, or ask what they are looking for.',
  };
}
