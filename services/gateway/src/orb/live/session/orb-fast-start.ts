/**
 * ORB-FAST-START Phase 2 — fast session/start helpers.
 *
 * The orb wake critical path historically blocked the `session/start` HTTP
 * response on the wake-brief continuation decision + journey-greeting block
 * (the heavy Brain/bootstrap context is already deferred to
 * `session.contextReadyPromise`). These helpers let the controller defer that
 * remaining work onto the SAME promise the stream-open gate already awaits
 * (`orb-live.ts` ~6178), so the response returns immediately while the first
 * personalized turn still carries full wake-brief / Teacher / Journey content.
 *
 * Gated by `FEATURE_ORB_FAST_START_ENV` (default `off` → legacy inline path).
 * The deferred work itself is byte-identical to the prior inline code — only
 * WHEN it runs changes. These helpers isolate the only NEW logic (the gating
 * decision + the promise composition) so it can be unit-tested in isolation.
 */

import { isFeatureLive } from '../../../services/feature-flags';

/**
 * Decide whether to defer the wake-brief + journey work off the session/start
 * response path.
 *
 * Only the authenticated, non-guided, non-anonymous path benefits: anonymous
 * sessions skip wake-brief/journey entirely, and the guided-topic fast path
 * (VTID-03294) already resolves context in a microtask. Gating those off keeps
 * their existing (cheap) inline behavior unchanged.
 */
export function shouldDeferWakeWork(opts: {
  isAnonymousSession: boolean;
  isGuidedTopicSession: boolean;
  hasUserId: boolean;
}): boolean {
  return (
    isFeatureLive('ORB_FAST_START') &&
    !opts.isAnonymousSession &&
    !opts.isGuidedTopicSession &&
    opts.hasUserId
  );
}

/**
 * Compose the existing brain/bootstrap readiness promise with the deferred
 * wake-brief + journey work into a single promise the stream-open gate awaits.
 *
 * Uses `allSettled` so a rejection in either input cannot reject the composed
 * gate promise — the gate's own try/catch then proceeds with whatever session
 * fields were populated (fail-open, identical to today's behavior when a
 * wake-brief/journey try-block throws).
 */
export function composeContextReady(
  brainReady: Promise<void> | undefined,
  deferredWork: () => Promise<unknown>,
): Promise<void> {
  return (async () => {
    await Promise.allSettled([brainReady ?? Promise.resolve(), deferredWork()]);
  })();
}
