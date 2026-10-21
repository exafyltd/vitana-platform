/**
 * VTID-03731 — unit tests for the standing all-languages ORB voice test
 * program.
 *
 * These are structural/coverage checks, not network tests — the program's
 * real value is exercised by actually running it against a live gateway
 * (see `docs/validation/VTID-03731/commands.log`), which this suite
 * cannot do without violating CLAUDE.md's absolute test-account rule in
 * spirit (repeated live network calls on every `npm test` run). What CAN
 * be verified statically, and is exactly the kind of gap this codebase
 * has been burned by before (VTID-03578/03681/03719/03730's shared shape:
 * a language quietly missing from ONE of several must-agree tables), is
 * pinned here instead.
 */

import { SUPPORTED_LIVE_LANGUAGES } from '../../src/orb/live/config';
import { NOVA_SONIC_SUPPORTED_LANGUAGES } from '../../src/orb/live/upstream/nova-sonic-config';
import {
  TEST_PHRASES,
  NOVA_NATIVE,
  SERBIAN_EXPECTED_FAIL,
} from '../../../../scripts/tts/verify-all-orb-languages';

describe('VTID-03731: verify-all-orb-languages coverage', () => {
  it('has a test phrase for every language the live gate admits', () => {
    // The exact failure mode this test exists to catch: a language added
    // to SUPPORTED_LIVE_LANGUAGES without a matching entry here would
    // otherwise silently fail this program's own "no test phrase defined"
    // branch at RUNTIME, on the next live run, instead of at commit time.
    for (const lang of SUPPORTED_LIVE_LANGUAGES) {
      expect(TEST_PHRASES[lang]).toBeTruthy();
      expect(typeof TEST_PHRASES[lang]).toBe('string');
      expect(TEST_PHRASES[lang].length).toBeGreaterThan(10);
    }
  });

  it('does not carry a stale test phrase for a language the gate no longer admits', () => {
    // The mirror image of the check above — a phrase for a retired
    // language is harmless today but silently misleading: it implies
    // coverage for something no longer live.
    for (const lang of Object.keys(TEST_PHRASES)) {
      expect(SUPPORTED_LIVE_LANGUAGES).toContain(lang);
    }
  });

  it('NOVA_NATIVE matches NOVA_SONIC_SUPPORTED_LANGUAGES exactly', () => {
    // This script deliberately keeps its own literal (see the header
    // comment on NOVA_NATIVE) rather than importing the value it cross-
    // checks the live routing decision against — importing it would make
    // a real desync between the config and the live route invisible.
    // This test is the one place that literal is verified to still agree
    // with the real source of truth, so drift is caught here, in CI,
    // rather than only by a live run silently asserting against itself.
    expect([...NOVA_NATIVE].sort()).toEqual([...NOVA_SONIC_SUPPORTED_LANGUAGES].sort());
  });

  it('sr is the one declared cascade-ineligible language, and is a real member of the gate', () => {
    expect(SUPPORTED_LIVE_LANGUAGES).toContain(SERBIAN_EXPECTED_FAIL);
    expect(SERBIAN_EXPECTED_FAIL).toBe('sr');
  });
});
