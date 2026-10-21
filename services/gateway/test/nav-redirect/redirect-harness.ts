/**
 * VTID-04607 — run one redirect case through the real `navigate` tool and
 * grade what came back. Shared by the CI suite and the live runner, so both
 * judge a case the same way.
 */
import { pageOf, NavScreen } from '../../src/navigation/nav-registry';
import { findRegistryScreen } from '../../src/navigation/nav-dispatch';
import { dispatchOrbTool } from '../../src/services/orb-tools-shared';
import type { ParaphraseCase, RedirectCase } from './redirect-cases';

/**
 * `open`    — the tool returned a navigate directive for an expected screen,
 *             with the right route for the member's device.
 * `handoff` — no screen was certain enough to open on its own; the tool
 *             handed the voice model a short list with an expected screen
 *             first and told it to open that one. The voice layer checks
 *             that the model then does.
 * `offer`   — a "where" question: the expected screen was offered, not opened.
 * `wrong`   — a different screen opened, or was put first.
 * `none`    — nothing useful came back.
 */
export type RedirectOutcome = 'open' | 'handoff' | 'offer' | 'wrong' | 'none';

export interface RedirectResult {
  id: string;
  lang: string;
  say: string;
  expect: string[];
  outcome: RedirectOutcome;
  decision: string;
  screen_id: string | null;
  route: string | null;
  entry_kind: string | null;
  candidates: string[];
  problems: string[];
  ms: number;
}

/** The route the web client must receive for this screen on this device. */
export function expectedRoute(screen: NavScreen, viewport: 'mobile' | 'desktop'): { page: string; overlayMarker: string | null } {
  const base = viewport === 'mobile' && screen.mobileRoute ? screen.mobileRoute : screen.route;
  return { page: pageOf(base), overlayMarker: screen.overlay?.marker ?? null };
}

/** Checks a navigate directive against the registry, independently of the dispatcher. */
export function directiveProblems(d: Record<string, any>, viewport: 'mobile' | 'desktop'): string[] {
  const problems: string[] = [];
  const screen = findRegistryScreen(String(d.screen_id));
  if (!screen) return [`directive names unknown screen ${d.screen_id}`];
  const want = expectedRoute(screen, viewport);
  if (d.type !== 'orb_directive' || d.directive !== 'navigate') problems.push('not a navigate directive');
  if (typeof d.route !== 'string' || pageOf(d.route) !== want.page) problems.push(`route ${d.route} is not on ${want.page}`);
  if (screen.overlay) {
    if (d.entry_kind !== 'overlay') problems.push(`popup ${screen.id} sent as ${d.entry_kind}`);
    if (want.overlayMarker && !String(d.route).includes(`open=${encodeURIComponent(want.overlayMarker)}`)) {
      problems.push(`popup route ${d.route} lacks open=${want.overlayMarker}`);
    }
  } else if (d.entry_kind !== 'route') {
    problems.push(`page ${screen.id} sent as ${d.entry_kind}`);
  }
  if (d.after_speech !== true) problems.push('directive does not wait for Vitana to finish speaking');
  return problems;
}

export const REDIRECT_CURRENT_ROUTE = '/home';

/**
 * `modelQuestion`: what the voice model passes as `question`, when it is not
 * the member's own sentence; the sentence then travels as the session
 * transcript, the way orb-live's handleNavigate sends it.
 */
export async function runRedirectCase(c: RedirectCase, modelQuestion?: string): Promise<RedirectResult> {
  const viewport = c.viewport ?? 'desktop';
  const identity = {
    user_id: 'redirect-suite-user',
    tenant_id: 'redirect-suite-tenant',
    role: 'community',
    lang: c.lang,
    session_id: `redirect-suite-${c.id}`,
    is_anonymous: false,
    is_mobile: viewport === 'mobile',
  };
  const started = Date.now();
  const r: any = await dispatchOrbTool(
    'navigate',
    {
      question: modelQuestion ?? c.say,
      intent: c.intent ?? 'open',
      current_route: c.from ?? REDIRECT_CURRENT_ROUTE,
      is_mobile: viewport === 'mobile',
      transcript_excerpt: c.say,
    },
    identity as any,
    // No client: nothing in the navigation path may write. The only use is
    // holding an offer, and that needs NAV_CONTINUATION_BIND, off here.
    null as any,
  );
  const ms = Date.now() - started;
  const res = r?.result ?? {};
  const d = res.directive;
  const candidates: string[] = (res.candidates ?? []).map((x: any) => x.screen_id);
  const base = { id: c.id, lang: c.lang, say: c.say, expect: c.expect, candidates, ms };

  if (r?.ok === false) {
    return { ...base, outcome: 'none', decision: 'error', screen_id: null, route: null, entry_kind: null, problems: [String(r.error)] };
  }
  if (d) {
    const problems = directiveProblems(d, viewport);
    const right = c.expect.includes(d.screen_id);
    return {
      ...base,
      outcome: right && !problems.length ? 'open' : 'wrong',
      decision: 'open',
      screen_id: d.screen_id,
      route: d.route,
      entry_kind: d.entry_kind,
      problems: right ? problems : [`opened ${d.screen_id}, expected ${c.expect.join(' or ')}`, ...problems],
    };
  }
  if (res.already_there) {
    return { ...base, outcome: 'wrong', decision: 'already_there', screen_id: res.screen_id, route: res.route, entry_kind: null, problems: ['answered "already there"'] };
  }
  const decision = String(res.decision ?? 'none');
  if (decision === 'offer' && res.offer?.screen_id) {
    const offered = String(res.offer.screen_id);
    const right = c.expect.includes(offered) && (c.intent ?? 'open') === 'where';
    return {
      ...base,
      outcome: right ? 'offer' : 'wrong',
      decision,
      screen_id: offered,
      route: null,
      entry_kind: null,
      problems: right ? [] : [`offered ${offered}${(c.intent ?? 'open') === 'open' ? ' instead of opening' : ''}, expected ${c.expect.join(' or ')}`],
    };
  }
  if (decision === 'ambiguous' && candidates.length) {
    const first = candidates[0];
    const right = c.expect.includes(first);
    return {
      ...base,
      outcome: right ? 'handoff' : 'wrong',
      decision,
      screen_id: first,
      route: null,
      entry_kind: null,
      problems: right ? [] : [`first candidate ${first}, expected ${c.expect.join(' or ')}`],
    };
  }
  return { ...base, outcome: 'none', decision, screen_id: null, route: null, entry_kind: null, problems: [`no screen (${decision})`] };
}

export function summarizeRedirect(results: RedirectResult[]) {
  const count = (o: RedirectOutcome) => results.filter((r) => r.outcome === o).length;
  return { total: results.length, open: count('open'), handoff: count('handoff'), offer: count('offer'), wrong: count('wrong'), none: count('none') };
}

export function formatRedirectTable(results: RedirectResult[]): string {
  return results
    .map((r) => `${r.id} ${r.outcome.padEnd(7)} ${r.lang} ${String(r.screen_id).padEnd(32)} ${String(r.route ?? '').padEnd(40)} ${r.say}${r.problems.length ? `  !! ${r.problems.join('; ')}` : ''}`)
    .join('\n');
}

export function runParaphraseCase(p: ParaphraseCase): Promise<RedirectResult> {
  return runRedirectCase({ id: p.id, lang: p.lang, say: p.say, expect: p.expect }, p.modelQuestion);
}

/** A navigate_to_screen call with a screen id nobody gave the model. */
export async function runInventedIdCase(screenId: string): Promise<{ screen_id: string | null; route: string | null; ok: boolean; text: string }> {
  const identity = {
    user_id: 'redirect-suite-user', tenant_id: 'redirect-suite-tenant', role: 'community', lang: 'de',
    session_id: 'redirect-suite-invented', is_anonymous: false, is_mobile: false,
  };
  const r: any = await dispatchOrbTool(
    'navigate_to_screen',
    // Started from Events, where the production session was.
    { screen_id: screenId, current_route: '/comm/events-meetups', transcript_excerpt: 'ja bitte' },
    identity as any,
    null as any,
  );
  const d = r?.result?.directive;
  return { screen_id: d?.screen_id ?? null, route: d?.route ?? null, ok: r?.ok !== false, text: String(r?.text ?? r?.error ?? '') };
}
