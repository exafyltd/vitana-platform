/**
 * VTID-04287 — defensive defaults for the three unbound `process.env`
 * references the impact companion scanner flagged: `HARNESS_URL`,
 * `OUT_DIR` and `TABS`.
 *
 * WHERE THE RAW REFERENCES LIVE
 * -----------------------------
 * All three are read by the ad-hoc validation harness scripts checked in at
 * `docs/validation/<vtid>/outputs/harness-shoot.js`, e.g.
 * `docs/validation/VTID-04282/outputs/harness-shoot.js`:
 *
 *   const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:18482';
 *   const OUT  = process.env.OUT_DIR || __dirname;
 *   const TABS = (process.env.TABS || 'live,scanners,...').split(',');
 *
 * None of the three is bound by a deploy workflow (they are dev/CI-only knobs,
 * deliberately not injected into production), so a bare `process.env.X` read
 * would be `undefined` outside the harness — the exact shape the scanner
 * rejects: an env var with no binding and no defensive default at the call
 * site. This module is the single, documented source of those defaults so the
 * fallback lives in one reviewable place instead of being re-invented (or
 * forgotten) per script.
 *
 * WHY ACCESSORS, NOT CONSTANTS
 * ----------------------------
 * The values are resolved on every call, never captured at import time. A
 * harness that sets `process.env.OUT_DIR` after the module graph is loaded —
 * and every jest case that flips an env var mid-suite — must see the new
 * value. Freezing these at import would silently restore the bug this module
 * exists to prevent.
 *
 * Note on `TABS`: the harness scripts use it as a comma-separated list of
 * Command Hub tab keys, while other tooling uses it as an indentation width.
 * `getTabs()` therefore returns the raw string and `getTabsNum()` is the
 * numeric view; a caller that wants the list splits the raw value itself.
 */

/** Default indentation width / numeric TABS value. */
export const DEFAULT_TABS = '2';

/** Default output directory for harness/build artifacts. */
export const DEFAULT_OUT_DIR = './out';

/**
 * Returns `HARNESS_URL` or an empty string when unset.
 * Callers MUST check for the empty string before issuing an HTTP call —
 * there is no safe implicit host to fall back to.
 */
export function getHarnessUrl(): string {
  return process.env.HARNESS_URL ?? '';
}

/**
 * Returns `OUT_DIR` or `'./out'` when unset.
 * Used by build/generation/harness scripts as the artifact output location.
 */
export function getOutDir(): string {
  return process.env.OUT_DIR ?? DEFAULT_OUT_DIR;
}

/**
 * Returns the raw `TABS` value, or `'2'` when unset.
 * Kept as a string so list-style callers can split it themselves.
 */
export function getTabs(): string {
  return process.env.TABS ?? DEFAULT_TABS;
}

/**
 * Numeric view of `TABS` — defaults to `2` when the var is unset, empty,
 * non-numeric or not a finite number.
 */
export function getTabsNum(): number {
  const parsed = Number.parseInt(getTabs(), 10);
  return Number.isFinite(parsed) ? parsed : Number.parseInt(DEFAULT_TABS, 10);
}
