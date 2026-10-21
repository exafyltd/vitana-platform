/**
 * VTID-03250 — context-integrity gate (slice 1: time/location).
 *
 * The protection the founder demanded: lock the contract that the assistant's
 * ENVIRONMENT context (location + LOCAL TIME) must stay correct and must NOT
 * silently degrade when an upstream (geo-IP) fails. This codifies the fix for
 * the "Berlin / 8:30 PM at 15:44 in Cologne" hallucination and FAILS the build
 * if a future change re-breaks time resolution.
 *
 * Pure-unit layer here; a post-deploy production smoke (assert the LIVE
 * system_instruction contains the ENVIRONMENT block + a local time) is the
 * next gate layer.
 */

import {
  resolveSessionTimezone,
  isValidIanaTimezone,
} from '../../src/services/awareness-unified-context';

describe('isValidIanaTimezone', () => {
  it('accepts real IANA zones', () => {
    expect(isValidIanaTimezone('Europe/Berlin')).toBe(true);
    expect(isValidIanaTimezone('America/New_York')).toBe(true);
    expect(isValidIanaTimezone('UTC')).toBe(true);
  });
  it('rejects junk / empty', () => {
    expect(isValidIanaTimezone('Not/AZone')).toBe(false);
    expect(isValidIanaTimezone('')).toBe(false);
    expect(isValidIanaTimezone(null)).toBe(false);
    expect(isValidIanaTimezone(undefined)).toBe(false);
  });
});

describe('resolveSessionTimezone — time integrity under geo-IP failure', () => {
  it('CONTRACT: the browser timezone wins over geo-IP (reliable source)', () => {
    expect(
      resolveSessionTimezone({ clientTimezone: 'Europe/Berlin', geoTimezone: 'America/Chicago' }),
    ).toBe('Europe/Berlin');
  });

  it('CONTRACT: when geo-IP fails (429 → no zone), the browser timezone still gives us the local time', () => {
    // This is the exact production failure: geo-IP returned nothing for the
    // user's IP. The browser zone must keep time correct.
    expect(
      resolveSessionTimezone({ clientTimezone: 'Europe/Berlin', geoTimezone: null }),
    ).toBe('Europe/Berlin');
    expect(
      resolveSessionTimezone({ clientTimezone: 'Europe/Berlin', geoTimezone: undefined }),
    ).toBe('Europe/Berlin');
  });

  it('falls back to geo-IP when the client sent none', () => {
    expect(resolveSessionTimezone({ clientTimezone: null, geoTimezone: 'Europe/Berlin' })).toBe('Europe/Berlin');
  });

  it('an invalid client timezone falls through to geo-IP (never trust junk)', () => {
    expect(
      resolveSessionTimezone({ clientTimezone: 'Mars/Olympus', geoTimezone: 'Europe/Berlin' }),
    ).toBe('Europe/Berlin');
  });

  it('returns null only when neither source has a zone (env block then omits time, never fabricates it)', () => {
    expect(resolveSessionTimezone({ clientTimezone: null, geoTimezone: null })).toBeNull();
    expect(resolveSessionTimezone({})).toBeNull();
  });

  it('CONTRACT: a resolved zone yields the correct wall-clock for that zone (not UTC)', () => {
    // Pin an instant where Berlin (CEST, +2) and UTC differ by hours so a
    // regression that silently used UTC would be caught.
    const tz = resolveSessionTimezone({ clientTimezone: 'Europe/Berlin' });
    expect(tz).toBe('Europe/Berlin');
    const hourBerlin = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz!,
        hour: 'numeric',
        hour12: false,
      }).format(new Date('2026-06-01T13:44:00Z')),
    );
    // 13:44 UTC → 15:44 Berlin (CEST). A UTC fallback would give 13.
    expect(hourBerlin).toBe(15);
  });
});
