/**
 * ORB-FAST-START Phase 2 — unit tests for the gating decision + promise
 * composition. The deferred wake-brief/journey BODY is byte-identical to the
 * prior inline code (parity by construction), so these tests cover the only
 * genuinely new logic: when we defer, and that the composed gate promise
 * preserves the existing fail-open semantics.
 */

import { shouldDeferWakeWork, composeContextReady } from '../src/orb/live/session/orb-fast-start';

const FLAG = 'FEATURE_ORB_FAST_START_ENV';

describe('shouldDeferWakeWork', () => {
  const prev = process.env[FLAG];
  afterEach(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });

  it('defaults OFF — never defers when the flag is unset (legacy path preserved)', () => {
    delete process.env[FLAG];
    expect(
      shouldDeferWakeWork({ isAnonymousSession: false, isGuidedTopicSession: false, hasUserId: true }),
    ).toBe(false);
  });

  it('defers for an authenticated, non-guided, non-anonymous session when enabled in prod', () => {
    process.env[FLAG] = 'staging+prod';
    expect(
      shouldDeferWakeWork({ isAnonymousSession: false, isGuidedTopicSession: false, hasUserId: true }),
    ).toBe(true);
  });

  it('never defers anonymous sessions (they skip wake-brief/journey anyway)', () => {
    process.env[FLAG] = 'staging+prod';
    expect(
      shouldDeferWakeWork({ isAnonymousSession: true, isGuidedTopicSession: false, hasUserId: false }),
    ).toBe(false);
  });

  it('never defers guided-topic sessions (already on the VTID-03294 fast path)', () => {
    process.env[FLAG] = 'staging+prod';
    expect(
      shouldDeferWakeWork({ isAnonymousSession: false, isGuidedTopicSession: true, hasUserId: true }),
    ).toBe(false);
  });

  it('never defers when there is no user id', () => {
    process.env[FLAG] = 'staging+prod';
    expect(
      shouldDeferWakeWork({ isAnonymousSession: false, isGuidedTopicSession: false, hasUserId: false }),
    ).toBe(false);
  });
});

describe('composeContextReady', () => {
  it('resolves only after BOTH the brain promise and the deferred work settle', async () => {
    const order: string[] = [];
    let resolveBrain!: () => void;
    let resolveWork!: () => void;
    const brain = new Promise<void>((r) => {
      resolveBrain = () => {
        order.push('brain');
        r();
      };
    });
    const work = () =>
      new Promise<void>((r) => {
        resolveWork = () => {
          order.push('work');
          r();
        };
      });

    const gate = composeContextReady(brain, work);
    let settled = false;
    void gate.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveBrain();
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false); // work still pending

    resolveWork();
    await gate;
    expect(settled).toBe(true);
    expect(order).toEqual(['brain', 'work']);
  });

  it('is fail-open: a rejection in the deferred work does NOT reject the gate', async () => {
    const work = () => Promise.reject(new Error('wake-brief blew up'));
    await expect(composeContextReady(Promise.resolve(), work)).resolves.toBeUndefined();
  });

  it('is fail-open: a rejection in the brain promise does NOT reject the gate', async () => {
    const brain = Promise.reject(new Error('brain blew up'));
    await expect(composeContextReady(brain, () => Promise.resolve())).resolves.toBeUndefined();
  });

  it('tolerates an undefined brain promise (anonymous/guided never set one)', async () => {
    await expect(composeContextReady(undefined, () => Promise.resolve())).resolves.toBeUndefined();
  });
});
