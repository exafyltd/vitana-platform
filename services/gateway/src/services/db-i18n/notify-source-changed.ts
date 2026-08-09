// Tell CI that DB-backed user-visible source content changed. (VTID-03522)
//
// NO LANGUAGE LEFT BEHIND, for the content that does not live in git.
//
// `src/i18n/**` propagation is driven by push events: edit the German shard,
// I18N-PROPAGATE runs, every other language follows. Two user-visible surfaces
// have no push event to hang that on, because they are edited in the admin UI
// and published straight to the database:
//
//   * the Guided Journey curriculum  (journey_checklist_translations, 254 topics)
//   * the Navigator catalog          (nav_catalog_i18n)
//
// I18N-DB-SEED.yml already subscribes to `repository_dispatch: db-i18n-source-changed`
// and to a nightly cron. Until this module existed, only the cron ever fired, so
// "edit one session -> every language follows" was true but next-morning. This
// makes it immediate; the cron stays as the safety net.
//
// THREE PROPERTIES THIS MUST HAVE, in priority order
//
// 1. It must NEVER fail the operation that triggered it. Publishing a
//    curriculum is the admin's actual intent; notifying CI is a side effect.
//    A GitHub outage must not roll back a publish, so every path here resolves
//    and nothing is thrown to the caller.
//
// 2. A failure must be VISIBLE. Per "Never silence errors" — a dropped dispatch
//    is not harmless, it silently downgrades the guarantee from immediate to
//    next-morning. It is logged with a grep-able marker. The degradation is
//    bounded (the cron still catches it), which is exactly why this can afford
//    to be fire-and-forget in the first place.
//
// 3. Rapid edits must COALESCE. An admin fixing twenty Navigator entries fires
//    twenty writes. Twenty dispatches would be twenty workflow runs; the seeder
//    itself is cheap on a no-op (only units whose source_sha moved are
//    re-translated) but the Actions minutes are not free, and the runs would
//    serialize behind each other's concurrency group. One dispatch per window
//    is the same end state for a fraction of the cost.
//
// The coalescing window is per-process, so an N-instance ECS service can emit
// up to N dispatches per window rather than one. That is deliberate: the
// alternative is a distributed lock on a path whose worst case is already
// "a redundant run that finds nothing to do".

import { triggerRepositoryDispatch } from '../github-service';

/** The event type I18N-DB-SEED.yml subscribes to. Must match that workflow. */
export const DB_I18N_EVENT_TYPE = 'db-i18n-source-changed';

/** Coalesce burst edits into one dispatch. */
const WINDOW_MS = 30_000;

export type DbI18nSurface = 'journey-checklist' | 'nav-catalog';

export interface NotifyResult {
  /** Whether a dispatch was actually sent to GitHub. */
  dispatched: boolean;
  /** Why not, when `dispatched` is false. */
  reason?: 'disabled' | 'no_token' | 'coalesced' | 'error';
  detail?: string;
}

interface PendingWindow {
  timer: NodeJS.Timeout;
  surfaces: Set<DbI18nSurface>;
  reasons: Set<string>;
}

let pending: PendingWindow | null = null;

/** Reset module state. Tests only. */
export function __resetNotifierForTests(): void {
  if (pending) clearTimeout(pending.timer);
  pending = null;
}

function repo(env: NodeJS.ProcessEnv): string {
  return env.DB_I18N_DISPATCH_REPO || 'exafyltd/vitana-platform';
}

/**
 * Off switch. Default ON — the whole point of the feature is that propagation
 * does not depend on someone remembering to trigger it, so an opt-IN flag would
 * reintroduce exactly the manual step this removes. Set to 'off' to disable.
 */
function enabled(env: NodeJS.ProcessEnv): boolean {
  return (env.DB_I18N_AUTO_PROPAGATE ?? '').trim().toLowerCase() !== 'off';
}

/**
 * The workflow lives in THIS repo, so the ordinary platform token is enough —
 * no FRONTEND_DEPLOY_TOKEN-style cross-repo PAT is needed. Checked here rather
 * than letting github-service throw, so an unset token is reported as a
 * specific reason instead of an exception on a publish path.
 */
function hasToken(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.GITHUB_SAFE_MERGE_TOKEN);
}

async function send(
  surfaces: DbI18nSurface[],
  reasons: string[],
  env: NodeJS.ProcessEnv,
): Promise<NotifyResult> {
  try {
    await triggerRepositoryDispatch(repo(env), DB_I18N_EVENT_TYPE, {
      surfaces,
      reasons,
      emitted_at: new Date().toISOString(),
      vtid: 'VTID-03522',
    });
    console.log(
      `[db-i18n] dispatched ${DB_I18N_EVENT_TYPE} surfaces=${surfaces.join(',')} reasons=${reasons.join(',')}`,
    );
    return { dispatched: true };
  } catch (err) {
    // Loud, grep-able, and states the consequence rather than just the error —
    // "propagation is delayed to the nightly run" is the fact an operator
    // needs; the stack alone does not say that.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[db-i18n] DB_I18N_DISPATCH_FAILED surfaces=${surfaces.join(',')} — ` +
        `translations for the other languages will not update until the nightly ` +
        `I18N-DB-SEED cron. Cause: ${detail}`,
    );
    return { dispatched: false, reason: 'error', detail };
  }
}

/**
 * Announce that a DB-backed source surface changed.
 *
 * Fire-and-forget by contract: resolves, never rejects, and the returned
 * promise may be ignored. Callers that want to assert on the outcome (tests,
 * an admin endpoint reporting why nothing happened) can await it.
 */
export async function notifyDbI18nSourceChanged(
  surface: DbI18nSurface,
  reason: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NotifyResult> {
  if (!enabled(env)) return { dispatched: false, reason: 'disabled' };
  if (!hasToken(env)) {
    console.warn(
      `[db-i18n] ${surface} changed but GITHUB_SAFE_MERGE_TOKEN is unset — ` +
        `immediate propagation is off; the nightly I18N-DB-SEED cron still covers it.`,
    );
    return { dispatched: false, reason: 'no_token' };
  }

  // Join an open window rather than starting a second one.
  if (pending) {
    pending.surfaces.add(surface);
    pending.reasons.add(reason);
    return { dispatched: false, reason: 'coalesced' };
  }

  const surfaces = new Set<DbI18nSurface>([surface]);
  const reasons = new Set<string>([reason]);

  return await new Promise<NotifyResult>((resolve) => {
    const timer = setTimeout(() => {
      pending = null;
      void send([...surfaces], [...reasons], env).then(resolve);
    }, WINDOW_MS);

    // Do not hold the process open for a notification. A shutdown mid-window
    // loses at most one dispatch, which the cron then covers.
    timer.unref?.();

    pending = { timer, surfaces, reasons };
  });
}
