/**
 * ORB-FAST-START Phase 2 — unit tests for `shouldDeferWakeWork` and
 * `composeContextReady`.
 *
 * These two helpers are the ONLY new logic in the fast-start slice (the
 * deferred work itself is byte-identical to the prior inline code — see
 * the file's header comment). `shouldDeferWakeWork` is a pure gating
 * decision; `composeContextReady` is the promise composition that must
 * never let a rejection in either input escape (fail-open contract).
 */

import { isFeatureLive } from '../../../../src/services/feature-flags';
import {
  shouldDeferWakeWork,
  composeContextReady,
} from '../../../../src/orb/live/session/orb-fast-start';

jest.mock('../../../../src/services/feature-flags', () => ({
  isFeatureLive: jest.fn(),
}));

const mockIsFeatureLive = isFeatureLive as jest.MockedFunction<typeof isFeatureLive>;

describe('shouldDeferWakeWork', () => {
  afterEach(() => jest.clearAllMocks());

  it('defers when the flag is live and the session is authenticated, non-anonymous, non-guided', () => {
    mockIsFeatureLive.mockReturnValue(true);
    expect(
      shouldDeferWakeWork({
        isAnonymousSession: false,
        isGuidedTopicSession: false,
        hasUserId: true,
      }),
    ).toBe(true);
  });

  it('reads the flag under the exact "ORB_FAST_START" key', () => {
    mockIsFeatureLive.mockReturnValue(true);
    shouldDeferWakeWork({ isAnonymousSession: false, isGuidedTopicSession: false, hasUserId: true });
    expect(mockIsFeatureLive).toHaveBeenCalledWith('ORB_FAST_START');
  });

  it('never defers when the flag is off, regardless of session shape', () => {
    mockIsFeatureLive.mockReturnValue(false);
    expect(
      shouldDeferWakeWork({ isAnonymousSession: false, isGuidedTopicSession: false, hasUserId: true }),
    ).toBe(false);
  });

  it('never defers an anonymous session even when the flag is live', () => {
    mockIsFeatureLive.mockReturnValue(true);
    expect(
      shouldDeferWakeWork({ isAnonymousSession: true, isGuidedTopicSession: false, hasUserId: true }),
    ).toBe(false);
  });

  it('never defers a guided-topic session even when the flag is live', () => {
    mockIsFeatureLive.mockReturnValue(true);
    expect(
      shouldDeferWakeWork({ isAnonymousSession: false, isGuidedTopicSession: true, hasUserId: true }),
    ).toBe(false);
  });

  it('never defers when there is no user id, even when the flag is live', () => {
    mockIsFeatureLive.mockReturnValue(true);
    expect(
      shouldDeferWakeWork({ isAnonymousSession: false, isGuidedTopicSession: false, hasUserId: false }),
    ).toBe(false);
  });

  it('requires ALL gating conditions simultaneously (anonymous AND guided AND no-user all false-failing)', () => {
    mockIsFeatureLive.mockReturnValue(true);
    // Anonymous AND guided AND no user id — every gate fails at once.
    expect(
      shouldDeferWakeWork({ isAnonymousSession: true, isGuidedTopicSession: true, hasUserId: false }),
    ).toBe(false);
  });
});

describe('composeContextReady', () => {
  it('resolves once both the brain-ready promise and the deferred work settle', async () => {
    let brainResolved = false;
    let deferredCalled = false;
    const brainReady = Promise.resolve().then(() => {
      brainResolved = true;
    });
    const deferredWork = jest.fn(async () => {
      deferredCalled = true;
    });

    await composeContextReady(brainReady, deferredWork);

    expect(brainResolved).toBe(true);
    expect(deferredCalled).toBe(true);
    expect(deferredWork).toHaveBeenCalledTimes(1);
  });

  it('treats an undefined brainReady as already resolved (does not hang or throw)', async () => {
    const deferredWork = jest.fn().mockResolvedValue(undefined);
    await expect(composeContextReady(undefined, deferredWork)).resolves.toBeUndefined();
    expect(deferredWork).toHaveBeenCalledTimes(1);
  });

  it('fail-open: a rejected brainReady does NOT reject the composed promise', async () => {
    const brainReady = Promise.reject(new Error('brain bootstrap failed'));
    const deferredWork = jest.fn().mockResolvedValue(undefined);

    await expect(composeContextReady(brainReady, deferredWork)).resolves.toBeUndefined();
    expect(deferredWork).toHaveBeenCalledTimes(1);
  });

  it('fail-open: a rejected deferredWork does NOT reject the composed promise', async () => {
    const brainReady = Promise.resolve();
    const deferredWork = jest.fn().mockRejectedValue(new Error('wake-brief blew up'));

    await expect(composeContextReady(brainReady, deferredWork)).resolves.toBeUndefined();
  });

  it('fail-open: BOTH inputs rejecting still resolves the composed promise', async () => {
    const brainReady = Promise.reject(new Error('brain'));
    const deferredWork = jest.fn().mockRejectedValue(new Error('deferred'));

    await expect(composeContextReady(brainReady, deferredWork)).resolves.toBeUndefined();
  });

  it('calls deferredWork exactly once (not eagerly re-invoked by allSettled)', async () => {
    const deferredWork = jest.fn().mockResolvedValue('x');
    await composeContextReady(Promise.resolve(), deferredWork);
    expect(deferredWork).toHaveBeenCalledTimes(1);
  });

  it('waits for deferredWork even if brainReady resolves first (does not resolve early)', async () => {
    const order: string[] = [];
    const brainReady = Promise.resolve().then(() => order.push('brain'));
    const deferredWork = jest.fn(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            order.push('deferred');
            resolve();
          }, 10),
        ),
    );

    await composeContextReady(brainReady, deferredWork);
    order.push('composed-resolved');
    expect(order).toEqual(['brain', 'deferred', 'composed-resolved']);
  });
});
