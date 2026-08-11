// VTID-03522 — the DB-content propagation trigger.
//
// What is worth testing here is not "does it call fetch". It is the three
// properties whose violation would be INVISIBLE in production:
//
//   * it must never throw into a publish path (a failed notification that
//     rolls back a curriculum publish is far worse than a late translation)
//   * a failure must be reported, not swallowed (the whole class of bug this
//     programme keeps hitting: es/sr at "100% coverage" while serving German)
//   * bursts must coalesce (twenty nav edits must not be twenty workflow runs)

import {
  notifyDbI18nSourceChanged,
  __resetNotifierForTests,
  DB_I18N_EVENT_TYPE,
} from '../../src/services/db-i18n/notify-source-changed';
import * as github from '../../src/services/github-service';

jest.mock('../../src/services/github-service', () => ({
  triggerRepositoryDispatch: jest.fn(),
}));

const dispatch = github.triggerRepositoryDispatch as jest.Mock;

const ENV_ON = { GITHUB_SAFE_MERGE_TOKEN: 'tok' } as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  jest.useFakeTimers();
  dispatch.mockReset();
  dispatch.mockResolvedValue(undefined);
  __resetNotifierForTests();
});

afterEach(() => {
  __resetNotifierForTests();
  jest.useRealTimers();
});

/** Drive the coalescing window and let the dispatch promise settle. */
async function flushWindow() {
  jest.advanceTimersByTime(30_000);
  await Promise.resolve();
  await Promise.resolve();
}

describe('event type', () => {
  it('matches the string I18N-DB-SEED.yml subscribes to', () => {
    // A rename on either side silently disconnects the trigger: the gateway
    // keeps reporting a successful dispatch and no workflow ever runs.
    expect(DB_I18N_EVENT_TYPE).toBe('db-i18n-source-changed');
  });
});

describe('dispatching', () => {
  it('sends one repository_dispatch to this repo after the window', async () => {
    const p = notifyDbI18nSourceChanged('journey-checklist', 'publish:v2-x', ENV_ON);
    expect(dispatch).not.toHaveBeenCalled(); // still coalescing
    await flushWindow();
    await expect(p).resolves.toEqual({ dispatched: true });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [repo, eventType, payload] = dispatch.mock.calls[0];
    expect(repo).toBe('exafyltd/vitana-platform');
    expect(eventType).toBe('db-i18n-source-changed');
    expect(payload.surfaces).toEqual(['journey-checklist']);
    expect(payload.reasons).toEqual(['publish:v2-x']);
  });

  it('coalesces a burst of edits into a single dispatch', async () => {
    const first = notifyDbI18nSourceChanged('nav-catalog', 'admin-write', ENV_ON);
    const rest = Array.from({ length: 19 }, () =>
      notifyDbI18nSourceChanged('nav-catalog', 'admin-write', ENV_ON),
    );

    // The 19 followers resolve immediately as coalesced, not as dispatches.
    for (const r of rest) {
      await expect(r).resolves.toEqual({ dispatched: false, reason: 'coalesced' });
    }

    await flushWindow();
    await expect(first).resolves.toEqual({ dispatched: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('merges distinct surfaces touched within one window', async () => {
    const p = notifyDbI18nSourceChanged('journey-checklist', 'publish:a', ENV_ON);
    await notifyDbI18nSourceChanged('nav-catalog', 'admin-write', ENV_ON);
    await flushWindow();
    await p;

    const payload = dispatch.mock.calls[0][2];
    expect(payload.surfaces.sort()).toEqual(['journey-checklist', 'nav-catalog']);
  });

  it('opens a fresh window after the previous one fired', async () => {
    const a = notifyDbI18nSourceChanged('nav-catalog', 'admin-write', ENV_ON);
    await flushWindow();
    await a;

    const b = notifyDbI18nSourceChanged('nav-catalog', 'admin-write', ENV_ON);
    await flushWindow();
    await b;

    // Otherwise the first burst would latch the notifier permanently closed and
    // every later edit would be silently dropped.
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

describe('failure isolation — the property that protects the publish path', () => {
  it('resolves rather than rejecting when GitHub errors', async () => {
    dispatch.mockRejectedValue(new Error('502 Bad Gateway'));
    const p = notifyDbI18nSourceChanged('journey-checklist', 'publish:x', ENV_ON);
    await flushWindow();

    // If this rejected, `void notify(...)` in publishChecklist would become an
    // unhandled rejection and, under Node's default, could take the process
    // down after a publish had already been committed.
    await expect(p).resolves.toEqual(
      expect.objectContaining({ dispatched: false, reason: 'error' }),
    );
  });

  it('reports the failure loudly instead of swallowing it', async () => {
    dispatch.mockRejectedValue(new Error('502 Bad Gateway'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const p = notifyDbI18nSourceChanged('nav-catalog', 'admin-write', ENV_ON);
    await flushWindow();
    await p;

    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).toContain('DB_I18N_DISPATCH_FAILED');
    expect(logged).toContain('502 Bad Gateway');
    spy.mockRestore();
  });

  it('does not dispatch, and says why, when the token is unset', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      notifyDbI18nSourceChanged('nav-catalog', 'admin-write', {} as NodeJS.ProcessEnv),
    ).resolves.toEqual({ dispatched: false, reason: 'no_token' });

    // Checked here rather than letting github-service throw, so an unset token
    // never surfaces as an exception on an admin publish.
    expect(dispatch).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('kill switch', () => {
  it('is ON by default — an opt-in flag would reintroduce the manual step', async () => {
    const p = notifyDbI18nSourceChanged('nav-catalog', 'admin-write', ENV_ON);
    await flushWindow();
    await expect(p).resolves.toEqual({ dispatched: true });
  });

  it('honours DB_I18N_AUTO_PROPAGATE=off', async () => {
    await expect(
      notifyDbI18nSourceChanged('nav-catalog', 'admin-write', {
        ...ENV_ON,
        DB_I18N_AUTO_PROPAGATE: 'off',
      } as unknown as NodeJS.ProcessEnv),
    ).resolves.toEqual({ dispatched: false, reason: 'disabled' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('treats any other value as enabled, rather than failing closed', async () => {
    // A typo'd flag must not silently disable propagation — the failure mode
    // would be "every language quietly stops updating".
    const p = notifyDbI18nSourceChanged('nav-catalog', 'admin-write', {
      ...ENV_ON,
      DB_I18N_AUTO_PROPAGATE: 'yes-please',
    } as unknown as NodeJS.ProcessEnv);
    await flushWindow();
    await expect(p).resolves.toEqual({ dispatched: true });
  });
});
