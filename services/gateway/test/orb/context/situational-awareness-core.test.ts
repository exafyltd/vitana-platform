/**
 * B0a — Situational Awareness Core unit tests.
 *
 * Verifies the Tier 0 compiler:
 *   - tolerates null envelope (returns degraded-but-typed defaults)
 *   - derives day_part_label + daylight_phase from localNow
 *   - flags missing envelope fields in envelopeCompleteness
 *   - propagates journeySurface verbatim (does NOT interpret it)
 *   - location freshness flips at the 15-minute boundary
 */

import {
  compileSituationalCore,
  SituationalCore,
} from '../../../src/orb/context/situational-awareness-core';
import type { ClientContextEnvelope } from '../../../src/orb/context/client-context-envelope';

const FIXED_NOW = Date.UTC(2026, 4, 11, 18, 30, 0); // 2026-05-11T18:30:00Z

describe('B0a — compileSituationalCore', () => {
  describe('null envelope tolerance', () => {
    it('returns a fully-typed degraded SituationalCore when envelope is null', () => {
      const core = compileSituationalCore(null, FIXED_NOW);
      expect(core.dayPartLabel).toBe('unknown');
      expect(core.daylightPhase).toBe('unknown');
      expect(core.locationFreshnessConfidence).toBe('unknown');
      expect(core.deviceClass).toBe('unknown');
      expect(core.privacySpeakingMode).toBe('unknown');
      expect(core.currentRoute).toBeNull();
      expect(core.journeySurface).toBe('unknown');
      // Every completeness flag is true (everything missing).
      for (const flag of Object.values(core.envelopeCompleteness)) {
        expect(flag).toBe(true);
      }
    });
  });

  describe('day_part_label derivation', () => {
    it.each([
      ['2026-05-11T07:00:00+02:00', 'morning'],
      ['2026-05-11T13:30:00+02:00', 'afternoon'],
      ['2026-05-11T19:15:00+02:00', 'evening'],
      ['2026-05-11T23:00:00+02:00', 'night'],
      ['2026-05-11T01:30:00+02:00', 'night'], // before 2am
      ['2026-05-11T03:30:00+02:00', 'late_night'], // 2-5am
    ])('localNow=%s → dayPartLabel=%s', (localNow, expected) => {
      const env: ClientContextEnvelope = { surface: 'mobile', localNow };
      const core = compileSituationalCore(env, FIXED_NOW);
      expect(core.dayPartLabel).toBe(expected);
    });

    it('returns "unknown" when localNow is missing', () => {
      const core = compileSituationalCore({ surface: 'mobile' }, FIXED_NOW);
      expect(core.dayPartLabel).toBe('unknown');
    });

    it('returns "unknown" when localNow is malformed', () => {
      const core = compileSituationalCore(
        { surface: 'mobile', localNow: 'not-an-iso-date' },
        FIXED_NOW,
      );
      expect(core.dayPartLabel).toBe('unknown');
    });
  });

  describe('location freshness', () => {
    it('marks location as "high" when captured under 15 minutes ago', () => {
      const fiveMinAgo = new Date(FIXED_NOW - 5 * 60 * 1000).toISOString();
      const core = compileSituationalCore(
        {
          surface: 'mobile',
          location: { lat: 52.5, lng: 13.4, capturedAt: fiveMinAgo },
        },
        FIXED_NOW,
      );
      expect(core.locationFreshnessConfidence).toBe('high');
      expect(core.envelopeCompleteness.locationStale).toBe(false);
    });

    it('marks location as "low" past 15 minutes', () => {
      const twentyMinAgo = new Date(FIXED_NOW - 20 * 60 * 1000).toISOString();
      const core = compileSituationalCore(
        {
          surface: 'mobile',
          location: { lat: 52.5, lng: 13.4, capturedAt: twentyMinAgo },
        },
        FIXED_NOW,
      );
      expect(core.locationFreshnessConfidence).toBe('low');
      expect(core.envelopeCompleteness.locationStale).toBe(true);
    });

    it('marks location as "unknown" when no capturedAt is provided', () => {
      const core = compileSituationalCore(
        {
          surface: 'mobile',
          location: { lat: 52.5, lng: 13.4 },
        },
        FIXED_NOW,
      );
      expect(core.locationFreshnessConfidence).toBe('unknown');
    });
  });

  describe('match-journey injection: journeySurface propagates verbatim', () => {
    const surfaces = [
      'intent_board',
      'intent_card',
      'pre_match_whois',
      'match_detail',
      'match_chat',
      'activity_plan',
      'matches_hub',
      'notification_center',
      'command_hub',
    ] as const;

    it.each(surfaces)('journeySurface=%s passes through verbatim (no interpretation)', (surface) => {
      const core = compileSituationalCore(
        { surface: 'mobile', journeySurface: surface },
        FIXED_NOW,
      );
      expect(core.journeySurface).toBe(surface);
      // The core MUST NOT add match-related fields. Snapshot the SituationalCore
      // shape and verify there's no `matchJourney`, `matchId`, etc.
      const allowedKeys: Array<keyof SituationalCore> = [
        'dayPartLabel',
        'daylightPhase',
        'locationFreshnessConfidence',
        'deviceClass',
        'privacySpeakingMode',
        'currentRoute',
        'journeySurface',
        'envelopeCompleteness',
      ];
      expect(Object.keys(core).sort()).toEqual([...allowedKeys].sort());
    });

    it('journeySurface defaults to "unknown" when omitted', () => {
      const core = compileSituationalCore({ surface: 'mobile' }, FIXED_NOW);
      expect(core.journeySurface).toBe('unknown');
      expect(core.envelopeCompleteness.journeySurfaceMissing).toBe(true);
    });
  });

  describe('envelope completeness flags', () => {
    it('flags every missing field', () => {
      const core = compileSituationalCore({ surface: 'mobile' }, FIXED_NOW);
      expect(core.envelopeCompleteness.journeySurfaceMissing).toBe(true);
      expect(core.envelopeCompleteness.routeMissing).toBe(true);
      expect(core.envelopeCompleteness.timezoneMissing).toBe(true);
      expect(core.envelopeCompleteness.localNowMissing).toBe(true);
      expect(core.envelopeCompleteness.deviceClassMissing).toBe(true);
      expect(core.envelopeCompleteness.privacyModeMissing).toBe(true);
      expect(core.envelopeCompleteness.locationMissing).toBe(true);
    });

    it('marks fields present when envelope is fully populated', () => {
      const fullEnvelope: ClientContextEnvelope = {
        surface: 'mobile',
        journeySurface: 'match_detail',
        route: '/matches/abc',
        timezone: 'Europe/Berlin',
        localNow: '2026-05-11T18:30:00+02:00',
        deviceClass: 'ios_webview',
        privacyMode: 'private',
        location: {
          lat: 52.52,
          lng: 13.405,
          capturedAt: new Date(FIXED_NOW - 60 * 1000).toISOString(),
        },
      };
      const core = compileSituationalCore(fullEnvelope, FIXED_NOW);
      expect(core.envelopeCompleteness.journeySurfaceMissing).toBe(false);
      expect(core.envelopeCompleteness.routeMissing).toBe(false);
      expect(core.envelopeCompleteness.timezoneMissing).toBe(false);
      expect(core.envelopeCompleteness.localNowMissing).toBe(false);
      expect(core.envelopeCompleteness.deviceClassMissing).toBe(false);
      expect(core.envelopeCompleteness.privacyModeMissing).toBe(false);
      expect(core.envelopeCompleteness.locationMissing).toBe(false);
      expect(core.envelopeCompleteness.locationStale).toBe(false);
    });
  });
});
