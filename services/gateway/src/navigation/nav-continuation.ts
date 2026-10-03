/**
 * VTID-04521 — the directive for an accepted navigation offer.
 *
 * NAV_CONTINUATION_BIND opens the held offer when the member answers a bare
 * "yes". It used to emit the stored route directly: no gates, no speech
 * first, and the session-lifetime `navigationDispatched` latch set, which
 * dropped the member's microphone for the rest of the session. The accepted
 * offer goes through openScreen() like any other navigation — every gate,
 * speak first, confirmed by the app's nav_result — and the latch stays off.
 * VTID-04846: an offer for a screen the registry no longer has opens nothing.
 */
import { findRegistryScreen, isNavigationOffSurface, openScreen } from './nav-dispatch';
import { recordPendingNavAck, type NavAckSession } from './nav-ack';

export interface ContinuationSession extends NavAckSession {
  lang?: string;
  isAnonymous?: boolean;
  is_mobile?: boolean;
  clientContext?: { isMobile?: boolean } | null;
}

export interface ContinuationDirective {
  directive: Record<string, unknown>;
  /** True for the legacy path: the session closes for navigation. */
  latch: boolean;
}

export async function buildContinuationDirective(
  session: ContinuationSession,
  payload: { screen_id?: string; route?: string; title?: string },
): Promise<ContinuationDirective | null> {
  if (!payload.screen_id) return null;
  const currentRoute = session.current_route || null;
  if (isNavigationOffSurface(currentRoute) || !findRegistryScreen(payload.screen_id)) return null;
  const r = await openScreen(payload.screen_id, 'continuation_accept', {
    lang: session.lang || 'en',
    isAnonymous: !!session.isAnonymous,
    isMobile: session.is_mobile === true || session.clientContext?.isMobile === true,
    currentRoute,
    sessionId: session.sessionId || null,
  });
  const directive = r.ok ? (r.result as { directive?: Record<string, unknown> } | undefined)?.directive : undefined;
  if (!directive) return null; // blocked or already there: nothing to open
  recordPendingNavAck(session, directive);
  return { directive, latch: false };
}
