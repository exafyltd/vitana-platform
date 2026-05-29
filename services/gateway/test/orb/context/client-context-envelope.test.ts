/**
 * B0a acceptance check #1: `ClientContextEnvelope` round-trips all 9
 * `journeySurface` values from vitana-v1 to the gateway without coercion
 * or rename.
 *
 * Per the match-journey injection (plan, 2026-05-11): the 9 surfaces
 * MUST pass through the zod parser unchanged. Any coercion (e.g.
 * accepting `intent-board` and normalizing to `intent_board`) is a
 * contract violation — the populator and the gateway must agree on
 * the EXACT enum.
 *
 * This test is the "contract validation" gate. It does NOT verify any
 * match-concierge behavior — only that the rails accept the reserved
 * surface values.
 */

import {
  JOURNEY_SURFACE_VALUES,
  parseClientContextEnvelope,
  ClientContextEnvelope,
} from '../../../src/orb/context/client-context-envelope';

describe('B0a — ClientContextEnvelope contract', () => {
  describe('acceptance check #1: 9 journeySurface values round-trip without coercion', () => {
    const MATCH_JOURNEY_SURFACES = [
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

    it.each(MATCH_JOURNEY_SURFACES)(
      'journeySurface=%s round-trips through the zod parser unchanged',
      (surface) => {
        const input: ClientContextEnvelope = {
          surface: 'mobile',
          journeySurface: surface,
        };
        const result = parseClientContextEnvelope(input);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.envelope.journeySurface).toBe(surface);
        }
      },
    );

    it('all 9 match-journey surfaces are members of JOURNEY_SURFACE_VALUES (plus "unknown")', () => {
      for (const s of MATCH_JOURNEY_SURFACES) {
        expect(JOURNEY_SURFACE_VALUES).toContain(s);
      }
      expect(JOURNEY_SURFACE_VALUES).toContain('unknown');
      // Total enum cardinality: 9 match surfaces + 'unknown' = 10.
      expect(JOURNEY_SURFACE_VALUES.length).toBe(10);
    });

    it('rejects coerced surface variants (e.g. kebab-case, capitalized)', () => {
      const badInputs = [
        { surface: 'mobile', journeySurface: 'intent-board' },
        { surface: 'mobile', journeySurface: 'Intent_board' },
        { surface: 'mobile', journeySurface: 'INTENT_BOARD' },
        { surface: 'mobile', journeySurface: 'matchDetail' }, // camelCase
        { surface: 'mobile', journeySurface: 'random_surface' },
      ];
      for (const bad of badInputs) {
        const result = parseClientContextEnvelope(bad);
        expect(result.ok).toBe(false);
      }
    });
  });

  describe('schema strictness — no additional properties leak through', () => {
    it('rejects extra top-level properties', () => {
      const input = {
        surface: 'mobile',
        journeySurface: 'intent_board',
        extraField: 'should_be_rejected',
      };
      const result = parseClientContextEnvelope(input);
      expect(result.ok).toBe(false);
    });

    it('rejects extra location properties', () => {
      const input = {
        surface: 'mobile',
        location: {
          lat: 52.5,
          lng: 13.4,
          extraField: 'should_be_rejected',
        },
      };
      const result = parseClientContextEnvelope(input);
      expect(result.ok).toBe(false);
    });
  });

  describe('schema validation — required + optional fields', () => {
    it('accepts a minimal envelope with only `surface`', () => {
      const result = parseClientContextEnvelope({ surface: 'mobile' });
      expect(result.ok).toBe(true);
    });

    it('rejects an envelope missing `surface`', () => {
      const result = parseClientContextEnvelope({ journeySurface: 'intent_board' });
      expect(result.ok).toBe(false);
    });

    it('accepts a fully-populated envelope', () => {
      const input: ClientContextEnvelope = {
        surface: 'mobile',
        journeySurface: 'match_detail',
        route: '/matches/abc-123',
        timezone: 'Europe/Berlin',
        localNow: '2026-05-11T18:30:00+02:00',
        wakeOrigin: 'orb_tap',
        deviceClass: 'ios_webview',
        visibilityState: 'visible',
        networkRttMs: 45,
        location: {
          lat: 52.52,
          lng: 13.405,
          accuracyMeters: 25,
          permissionState: 'granted',
          capturedAt: '2026-05-11T18:29:50+02:00',
        },
        privacyMode: 'private',
      };
      const result = parseClientContextEnvelope(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Round-trip equality — every field survives the parse.
        expect(result.envelope).toEqual(input);
      }
    });
  });
});
