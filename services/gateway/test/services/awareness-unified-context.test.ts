/**
 * VTID-03248 (R1 slice 1) — canonical spoken-first-name resolver tests.
 *
 * Locks the single precedence (memory_facts → app_users → email) that both
 * the Vertex and LiveKit spoken-name sites now share, and proves it
 * reproduces the prior Vertex inline logic (so that migration is a no-op).
 */

import {
  resolveSpokenFirstName,
  type ResolvedFirstName,
} from '../../src/services/awareness-unified-context';

describe('resolveSpokenFirstName', () => {
  it('1) prefers memory_facts.user_name and returns the first token', () => {
    expect(
      resolveSpokenFirstName({
        memoryFactUserName: 'Dragan Alexander',
        displayName: 'Someone Else',
        email: 'x@y.com',
      }),
    ).toEqual<ResolvedFirstName>({ firstName: 'Dragan', source: 'memory_facts' });
  });

  it('2) falls back to app_users.display_name when no fact', () => {
    expect(
      resolveSpokenFirstName({ memoryFactUserName: null, displayName: 'Maria Rossi', email: 'x@y.com' }),
    ).toEqual<ResolvedFirstName>({ firstName: 'Maria', source: 'app_users' });
  });

  it('3) falls back to the email local-part, digit/sep-stripped + capitalized (faithful to existing logic)', () => {
    expect(
      resolveSpokenFirstName({ memoryFactUserName: '', displayName: '', email: 'dragan1@example.com' }),
    ).toEqual<ResolvedFirstName>({ firstName: 'Dragan', source: 'email' });
    // NOTE: the strip regex removes the separator char, so "d_stevanovic"
    // collapses to "Dstevanovic" (NOT "Stevanovic"). This reproduces the prior
    // Vertex inline behavior exactly — improving email-derived name quality is
    // a later, separate change, not this zero-behavior-change slice.
    expect(
      resolveSpokenFirstName({ email: 'd_stevanovic@hotmail.com' }),
    ).toEqual<ResolvedFirstName>({ firstName: 'Dstevanovic', source: 'email' });
  });

  it('4) returns none when nothing usable', () => {
    expect(resolveSpokenFirstName({})).toEqual<ResolvedFirstName>({ firstName: null, source: 'none' });
    expect(
      resolveSpokenFirstName({ memoryFactUserName: '   ', displayName: '   ', email: '' }),
    ).toEqual<ResolvedFirstName>({ firstName: null, source: 'none' });
  });

  it('5) does not derive from an email local-part shorter than 2 chars after stripping', () => {
    expect(
      resolveSpokenFirstName({ email: '1@example.com' }),
    ).toEqual<ResolvedFirstName>({ firstName: null, source: 'none' });
  });

  it('6) trims surrounding whitespace before tokenizing', () => {
    expect(
      resolveSpokenFirstName({ memoryFactUserName: '  Dragan  ' }),
    ).toEqual<ResolvedFirstName>({ firstName: 'Dragan', source: 'memory_facts' });
  });

  it('7) email fallback only triggers on a real address (must contain @)', () => {
    expect(resolveSpokenFirstName({ email: 'not-an-email' })).toEqual<ResolvedFirstName>({
      firstName: null,
      source: 'none',
    });
  });

  it('8) reproduces the prior Vertex inline behavior across the precedence chain', () => {
    // memory_facts present → memory_facts
    expect(resolveSpokenFirstName({ memoryFactUserName: 'Ana', displayName: 'B', email: 'c1@d.com' }).source).toBe('memory_facts');
    // only display → app_users
    expect(resolveSpokenFirstName({ displayName: 'Ben Stiller', email: 'c1@d.com' }).source).toBe('app_users');
    // only email → email
    expect(resolveSpokenFirstName({ email: 'carol2@d.com' })).toEqual<ResolvedFirstName>({ firstName: 'Carol', source: 'email' });
  });
});
