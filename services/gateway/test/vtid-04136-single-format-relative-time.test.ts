/**
 * VTID-04136 — app.js carried TWO top-level `function formatRelativeTime`
 * declarations (from an earlier, incompletely-fixed duplication — see the
 * 'fix-duplicate-formatRelativeTime' marker in
 * scripts/ci/command-hub-ownership-guard.js). Both are function declarations
 * in the same (script-global) scope, so the second one silently won: the
 * first was dead code that a reader could easily "fix" instead of the real
 * one.
 *
 * This suite pins (a) the structural invariant — exactly one declaration —
 * and (b) the survivor's behaviour at the seconds / minutes / hours / days
 * boundaries, evaluated out of the file itself (app.js is a plain script with
 * no module exports — same source-extraction pattern as
 * vtid-04033-operator-execution-follow.test.ts).
 *
 * Intended behaviour is UNCHANGED: the surviving implementation is the one
 * that was already running (function-declaration hoisting means the later
 * declaration is the live one for every call site).
 *
 * The boundary cases build their input from the real `Date.now()` at
 * assertion time. Each case sits exactly ON a boundary and the function's own
 * `Date.now()` runs strictly later, so the measured age can only round
 * *outward* (9.000s stays seconds, 60.000s is already a minute) — no flake.
 */

import * as fs from 'fs';
import * as path from 'path';

const APP_JS = fs.readFileSync(
  path.join(__dirname, '../src/frontend/command-hub/app.js'),
  'utf8'
);

const DECLARATION = /\nfunction formatRelativeTime\s*\(/g;

function declarations(): string[] {
  return APP_JS.match(DECLARATION) || [];
}

/** The surviving body, sliced from its declaration to the next top-level function. */
function survivorBody(): string {
  const start = APP_JS.search(DECLARATION);
  expect(start).toBeGreaterThan(-1);
  const next = APP_JS.indexOf('\nfunction ', start + 1);
  return APP_JS.slice(start, next === -1 ? undefined : next);
}

/** Evaluate the surviving implementation out of app.js, unmodified. */
function loadFormatRelativeTime(): (timestamp: unknown) => string {
  const src = survivorBody() + '\nreturn formatRelativeTime;';
  // eslint-disable-next-line no-new-func
  return new Function(src)() as (timestamp: unknown) => string;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A timestamp `ms` in the past, relative to the real clock at call time. */
const ago = (ms: number): number => Date.now() - ms;

describe('VTID-04136: app.js declares formatRelativeTime exactly once', () => {
  it('has a single top-level function formatRelativeTime declaration', () => {
    expect(declarations()).toHaveLength(1);
  });

  it('does not carry a second near-duplicate relative-time helper', () => {
    expect(APP_JS).not.toContain('function formatRelativeTimestamp');
    // The deleted duplicate's distinctive markers — its "Lovable-style
    // relative time" comment and its 45/90/36/14-unit ladder — are gone.
    expect(APP_JS).not.toContain('Lovable-style relative time');
    expect(APP_JS).not.toContain("if (seconds < 90) return '1m ago';");
    expect(APP_JS).not.toContain("if (hours < 36) return '1d ago';");
  });

  it('still has every pre-existing call site, unchanged', () => {
    for (const call of [
      'meta.textContent = formatRelativeTime(thread.updatedAt);',
      'timeLeft.appendChild(document.createTextNode(formatRelativeTime(version.createdAt)));',
      'eventTime.textContent = formatRelativeTime(ev.timestamp);',
      "lastUpdated.textContent = 'Updated: ' + formatRelativeTime(executionData.lastUpdated);",
      "time.textContent = formatRelativeTime(msg.ts) || msg.timestamp || '';",
    ]) {
      expect(APP_JS).toContain(call);
    }
  });
});

describe('VTID-04136: formatRelativeTime boundaries', () => {
  let formatRelativeTime: (timestamp: unknown) => string;

  beforeAll(() => {
    formatRelativeTime = loadFormatRelativeTime();
  });

  it('is empty for a missing timestamp (the falsy guard every call site relies on)', () => {
    expect(formatRelativeTime('')).toBe('');
    expect(formatRelativeTime(null)).toBe('');
    expect(formatRelativeTime(undefined)).toBe('');
  });

  it('seconds-ago: "just now" under 10s, then "<n>s ago" up to the 60s boundary', () => {
    expect(formatRelativeTime(ago(0))).toBe('just now');
    expect(formatRelativeTime(ago(9 * SECOND))).toBe('just now');
    expect(formatRelativeTime(ago(10 * SECOND))).toBe('10s ago');
    expect(formatRelativeTime(ago(59 * SECOND))).toBe('59s ago');
  });

  it('minutes-ago: the 60s boundary flips to "1m ago", and it holds until the 60m boundary', () => {
    expect(formatRelativeTime(ago(60 * SECOND))).toBe('1m ago');
    expect(formatRelativeTime(ago(2 * MINUTE))).toBe('2m ago');
    expect(formatRelativeTime(ago(59 * MINUTE))).toBe('59m ago');
  });

  it('hours-ago: the 60m boundary flips to "1h ago", and it holds until the 24h boundary', () => {
    expect(formatRelativeTime(ago(HOUR))).toBe('1h ago');
    expect(formatRelativeTime(ago(3 * HOUR))).toBe('3h ago');
    expect(formatRelativeTime(ago(23 * HOUR))).toBe('23h ago');
  });

  it('days-ago: the 24h boundary flips to "1d ago" and keeps counting (no date fallback)', () => {
    expect(formatRelativeTime(ago(DAY))).toBe('1d ago');
    expect(formatRelativeTime(ago(2 * DAY))).toBe('2d ago');
    expect(formatRelativeTime(ago(30 * DAY))).toBe('30d ago');
  });

  it('accepts an epoch number or an ISO string (call sites use one or the other)', () => {
    expect(formatRelativeTime(ago(3 * HOUR))).toBe('3h ago');
    expect(formatRelativeTime(new Date(ago(3 * HOUR)).toISOString())).toBe('3h ago');
  });

  it('treats a future timestamp as "just now" rather than a negative duration', () => {
    expect(formatRelativeTime(Date.now() + 5 * MINUTE)).toBe('just now');
  });

  it('leaves the pre-existing unparseable-input quirk exactly as it was', () => {
    // VTID-04136's mandate is "behaviour unchanged", so this is pinned as a
    // CHARACTERIZATION of the surviving implementation, not an endorsement:
    // an invalid date string produces NaN arithmetic rather than ''. The
    // deleted duplicate returned '' here, but it was never the live one.
    // Fixing this quirk is a separate, deliberate change.
    expect(formatRelativeTime('not-a-date')).toBe('NaNd ago');
  });
});
