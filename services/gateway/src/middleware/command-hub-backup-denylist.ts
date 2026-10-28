/**
 * VTID-04056: serve-time denylist for stale Command Hub artifacts.
 *
 * `app.use('/command-hub', express.static(staticPath, ...))` in `src/index.ts` is
 * mounted BEFORE the auth-gated `commandHubRouter`, so every file in
 * `src/frontend/command-hub/` was reachable by anyone, unauthenticated —
 * including the editor/laptop leftovers that no live page references:
 *
 *   app.js.backup, app.js.backup2, index.html.backup,
 *   index.html.backup-20251108-223919, debug.html
 *
 * They must NOT be deleted: `src/frontend/command-hub/BUILD.md`
 * (GOV-FRONTEND-CANONICAL-SOURCE-0001) explicitly forbids "Deleting backups or
 * safety artifacts". So the fix is serve-time only: mount this middleware
 * immediately before the `express.static` mount so those paths 404 and
 * `express.static` never sees them.
 *
 * Deny rules (`req.path` is already mount-relative, e.g. `/app.js.backup`):
 *   1. any path containing `.backup` — covers `.backup`, `.backup2` and
 *      `.backup-<timestamp>` suffixes,
 *   2. exactly `/debug.html`.
 * The path is percent-decoded first: `express.static` (via `send`) decodes the
 * request path, so `/app.js%2Ebackup` would otherwise slip past a naive
 * `endsWith('.backup')` check and be served.
 *
 * Everything else calls `next()` untouched.
 */
import { Request, Response, NextFunction } from 'express';

/** Exact (mount-relative, lowercased) paths that must never be served statically. */
export const COMMAND_HUB_DENIED_STATIC_EXACT_PATHS: readonly string[] = ['/debug.html'];

/** Substring that marks a stale/backup artifact, whatever its extension. */
export const COMMAND_HUB_DENIED_STATIC_SUBSTRING = '.backup';

/**
 * True when the (mount-relative) static request path must be denied.
 * Exposed as a pure predicate so it can be unit-tested directly.
 */
export function isDeniedCommandHubStaticPath(requestPath: string): boolean {
  let decoded = requestPath;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    // Malformed percent-encoding: fall back to the raw path so the substring
    // / exact checks below still run instead of throwing on a bad request.
    decoded = requestPath;
  }

  const normalized = decoded.toLowerCase();

  if (normalized.includes(COMMAND_HUB_DENIED_STATIC_SUBSTRING)) return true;

  return COMMAND_HUB_DENIED_STATIC_EXACT_PATHS.some((denied) => normalized === denied);
}

/**
 * Express middleware: 404 the stale/backup Command Hub artifacts, `next()`
 * everything else. Mount immediately before the `/command-hub`
 * `express.static` handler.
 */
export function denyCommandHubBackupFiles(req: Request, res: Response, next: NextFunction): void {
  if (isDeniedCommandHubStaticPath(req.path)) {
    res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return;
  }
  next();
}
