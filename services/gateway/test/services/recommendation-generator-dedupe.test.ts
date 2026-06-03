/**
 * Tests for the GRADED Autopilot dedupe policy — VTID-03201.
 *
 * Regression: the generator used to block regeneration of ANY fingerprint that
 * had ever existed in ANY status. A community user whose recommendations had
 * all expired or been rejected could therefore never get fresh ones, and the
 * Autopilot popup permanently emptied out.
 *
 * `isFingerprintBlocked` now encodes a graded policy:
 *   - expired rows never block (they're stale and replaceable)
 *   - live (new/snoozed) rows block
 *   - rejected rows block only inside a cooldown window
 *   - activated/completed one-off (onboarding_*) rows block forever
 *   - activated/completed repeatable rows do not block
 */

import {
  isFingerprintBlocked,
  REJECTED_COOLDOWN_DAYS,
  type FingerprintHistoryRow,
} from '../../src/services/recommendation-engine/recommendation-generator';

const NOW = Date.parse('2026-05-31T12:00:00Z');
const DAY = 86400000;

function row(overrides: Partial<FingerprintHistoryRow>): FingerprintHistoryRow {
  return {
    fingerprint: 'fp-test',
    source_ref: 'engage_meetup',
    status: 'new',
    updated_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 7 * DAY).toISOString(), // not expired by default
    ...overrides,
  };
}

describe('isFingerprintBlocked — graded dedupe policy', () => {
  describe('live recommendations', () => {
    it('blocks a live "new" rec', () => {
      expect(isFingerprintBlocked(row({ status: 'new' }), NOW)).toBe(true);
    });

    it('blocks a live "snoozed" rec', () => {
      expect(isFingerprintBlocked(row({ status: 'snoozed' }), NOW)).toBe(true);
    });
  });

  describe('expiry always wins', () => {
    it('allows a "new" rec whose expires_at has passed', () => {
      expect(
        isFingerprintBlocked(row({ status: 'new', expires_at: new Date(NOW - DAY).toISOString() }), NOW),
      ).toBe(false);
    });

    it('allows a recently-rejected rec once it has expired', () => {
      expect(
        isFingerprintBlocked(
          row({ status: 'rejected', updated_at: new Date(NOW).toISOString(), expires_at: new Date(NOW - DAY).toISOString() }),
          NOW,
        ),
      ).toBe(false);
    });

    it('allows a one-off activated rec once it has expired', () => {
      expect(
        isFingerprintBlocked(
          row({ status: 'activated', source_ref: 'onboarding_profile', expires_at: new Date(NOW - DAY).toISOString() }),
          NOW,
        ),
      ).toBe(false);
    });

    it('treats a null expires_at as never-expiring (still subject to status rules)', () => {
      expect(isFingerprintBlocked(row({ status: 'new', expires_at: null }), NOW)).toBe(true);
    });
  });

  describe('rejected cooldown', () => {
    it('blocks a rec rejected inside the cooldown window', () => {
      const updated = new Date(NOW - (REJECTED_COOLDOWN_DAYS - 1) * DAY).toISOString();
      expect(isFingerprintBlocked(row({ status: 'rejected', updated_at: updated }), NOW)).toBe(true);
    });

    it('allows a rec rejected before the cooldown window', () => {
      const updated = new Date(NOW - (REJECTED_COOLDOWN_DAYS + 1) * DAY).toISOString();
      expect(isFingerprintBlocked(row({ status: 'rejected', updated_at: updated }), NOW)).toBe(false);
    });

    it('allows a rejected rec with a null updated_at (treated as long ago)', () => {
      expect(isFingerprintBlocked(row({ status: 'rejected', updated_at: null }), NOW)).toBe(false);
    });
  });

  describe('activated / completed', () => {
    it('blocks a completed one-off onboarding rec', () => {
      expect(
        isFingerprintBlocked(row({ status: 'completed', source_ref: 'onboarding_diary' }), NOW),
      ).toBe(true);
    });

    it('allows a completed repeatable rec to re-surface', () => {
      expect(
        isFingerprintBlocked(row({ status: 'completed', source_ref: 'pillar_template_sleep' }), NOW),
      ).toBe(false);
    });

    it('allows an activated repeatable engagement rec to re-surface', () => {
      expect(
        isFingerprintBlocked(row({ status: 'activated', source_ref: 'engage_meetup' }), NOW),
      ).toBe(false);
    });

    it('does not treat a null source_ref as one-off', () => {
      expect(
        isFingerprintBlocked(row({ status: 'activated', source_ref: null }), NOW),
      ).toBe(false);
    });
  });

  describe('unknown status', () => {
    it('does not block an unrecognized status', () => {
      expect(isFingerprintBlocked(row({ status: 'archived' }), NOW)).toBe(false);
    });
  });

  describe('end-to-end scenario: only expired + rejected rows remain', () => {
    it('a user whose recs are all expired/long-rejected gets nothing blocked', () => {
      const history: FingerprintHistoryRow[] = [
        row({ fingerprint: 'a', status: 'rejected', updated_at: new Date(NOW - 60 * DAY).toISOString(), expires_at: new Date(NOW - 30 * DAY).toISOString() }),
        row({ fingerprint: 'b', status: 'new', expires_at: new Date(NOW - 2 * DAY).toISOString() }),
        row({ fingerprint: 'c', status: 'completed', source_ref: 'pillar_template_mental', expires_at: new Date(NOW - DAY).toISOString() }),
      ];
      const blocked = history.filter((r) => isFingerprintBlocked(r, NOW));
      expect(blocked).toHaveLength(0);
    });
  });
});
