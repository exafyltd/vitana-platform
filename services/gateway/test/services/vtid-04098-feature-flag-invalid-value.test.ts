/**
 * VTID-04098 — an unrecognised feature-flag value must not disable the feature
 * silently.
 *
 * Read off the LIVE production task definition (`vitana-gateway-awsdr` rev 108)
 * on 2026-09-19:
 *   FEATURE_LATENCY_TELEMETRY_ENV      = "production"
 *   FEATURE_ORB_SAFE_FAST_GREETING_ENV = "production"
 * Neither is one of the three accepted values, so both resolved to `off`.
 * Production had no phase-level voice latency telemetry and no greeting-facts
 * prefetch for weeks, while the task definition read as though it had both.
 */

import {
  isRecognisedFeatureFlagValue,
  featureFlagHasInvalidValue,
  featureFlagSetting,
  isFeatureLive,
} from '../../src/services/feature-flags';

describe('isRecognisedFeatureFlagValue', () => {
  it('accepts exactly the three documented values', () => {
    expect(isRecognisedFeatureFlagValue('off')).toBe(true);
    expect(isRecognisedFeatureFlagValue('staging-only')).toBe(true);
    expect(isRecognisedFeatureFlagValue('staging+prod')).toBe(true);
  });

  it('rejects the real value found live in production', () => {
    expect(isRecognisedFeatureFlagValue('production')).toBe(false);
  });

  it('rejects near-misses that look plausible to an operator', () => {
    for (const v of ['prod', 'true', 'on', 'enabled', 'staging', 'Staging-Only', 'staging+production', '']) {
      expect(isRecognisedFeatureFlagValue(v)).toBe(false);
    }
  });

  it('treats unset as not-a-value rather than invalid', () => {
    expect(isRecognisedFeatureFlagValue(undefined)).toBe(false);
  });
});

describe('featureFlagHasInvalidValue', () => {
  it('is false when the var is simply absent — that is a default, not a mistake', () => {
    expect(featureFlagHasInvalidValue('SOME_FLAG', {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is false for each accepted value', () => {
    for (const v of ['off', 'staging-only', 'staging+prod']) {
      expect(featureFlagHasInvalidValue('SOME_FLAG', { FEATURE_SOME_FLAG_ENV: v } as NodeJS.ProcessEnv)).toBe(false);
    }
  });

  it('is true for the production typo, which is the whole point', () => {
    expect(
      featureFlagHasInvalidValue('LATENCY_TELEMETRY', { FEATURE_LATENCY_TELEMETRY_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe('resolution is still safe, and now loud', () => {
  const ORIGINAL = process.env.FEATURE_VTID_04098_PROBE_ENV;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.FEATURE_VTID_04098_PROBE_ENV;
    else process.env.FEATURE_VTID_04098_PROBE_ENV = ORIGINAL;
    jest.restoreAllMocks();
  });

  it('still resolves an invalid value to off — the safe value is unchanged', () => {
    process.env.FEATURE_VTID_04098_PROBE_ENV = 'production';
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(featureFlagSetting('VTID_04098_PROBE')).toBe('off');
    expect(isFeatureLive('VTID_04098_PROBE')).toBe(false);
  });

  // Each of these uses its OWN probe flag name on purpose: the warn-once
  // dedupe is module-level and deliberate (this is read on the session hot
  // path), so two tests sharing a name would make the second one silent.
  it('logs an error naming the flag and saying it is NOT enabled', () => {
    process.env.FEATURE_VTID_04098_LOUD_ENV = 'production';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    isFeatureLive('VTID_04098_LOUD');
    delete process.env.FEATURE_VTID_04098_LOUD_ENV;
    const msg = spy.mock.calls.flat().join(' ');
    expect(msg).toContain('FEATURE_VTID_04098_LOUD_ENV');
    expect(msg).toMatch(/NOT enabled/);
  });

  it('warns once per flag, not once per session — this is read on the hot path', () => {
    process.env.FEATURE_VTID_04098_ONCE_ENV = 'production';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 25; i++) isFeatureLive('VTID_04098_ONCE');
    delete process.env.FEATURE_VTID_04098_ONCE_ENV;
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    expect(spy.mock.calls.length).toBe(1);
  });

  it('does not log for a valid value', () => {
    process.env.FEATURE_VTID_04098_PROBE_ENV = 'off';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    isFeatureLive('VTID_04098_PROBE_QUIET');
    expect(spy).not.toHaveBeenCalled();
  });
});
