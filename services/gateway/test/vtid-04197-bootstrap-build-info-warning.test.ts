/**
 * VTID-04197: parseBuildInfoTargets() warns loudly, server-side, exactly
 * once per process, when OPERATOR_BOOTSTRAP_BUILD_INFO_URLS is unset or
 * fails to parse to any valid target.
 *
 * Before this: the gap degraded silently — the bootstrap pack's own "Live
 * build-info" section rendered a "(no build-info targets configured …)"
 * line for the MODEL, but nothing was logged server-side, so an operator
 * checking CloudWatch for why the console has no live commit info would
 * see nothing at all.
 */

import {
  parseBuildInfoTargets,
  resetBuildInfoUnconfiguredWarning,
} from '../src/services/operator-bootstrap-pack';

describe('VTID-04197 parseBuildInfoTargets — loud warning on misconfiguration', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    resetBuildInfoUnconfiguredWarning();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns once when the env var is unset', () => {
    expect(parseBuildInfoTargets({})).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('OPERATOR_BOOTSTRAP_BUILD_INFO_URLS');
  });

  it('does not warn again on a second call within the same process', () => {
    parseBuildInfoTargets({});
    parseBuildInfoTargets({});
    parseBuildInfoTargets({ OPERATOR_BOOTSTRAP_BUILD_INFO_URLS: '' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns once when the env var is set but nothing parses (all entries malformed)', () => {
    const result = parseBuildInfoTargets({ OPERATOR_BOOTSTRAP_BUILD_INFO_URLS: 'bad, also-bad, c=http://insecure' });
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('bad, also-bad, c=http://insecure');
  });

  it('does NOT warn when at least one target parses correctly', () => {
    const result = parseBuildInfoTargets({ OPERATOR_BOOTSTRAP_BUILD_INFO_URLS: 'staging=https://x/build-info' });
    expect(result).toEqual([{ label: 'staging', url: 'https://x/build-info' }]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resetBuildInfoUnconfiguredWarning() allows the warning to fire again', () => {
    parseBuildInfoTargets({});
    expect(warnSpy).toHaveBeenCalledTimes(1);
    resetBuildInfoUnconfiguredWarning();
    parseBuildInfoTargets({});
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('the pre-existing malformed-entries-mixed-with-good-ones behavior is unchanged', () => {
    // Regression guard: this exact case existed before this VTID and must
    // still return only the two valid entries, with no warning (2 > 0).
    expect(parseBuildInfoTargets({ OPERATOR_BOOTSTRAP_BUILD_INFO_URLS: 'a=https://x/b, b=https://y , bad, c=http://insecure' }))
      .toEqual([{ label: 'a', url: 'https://x/b' }, { label: 'b', url: 'https://y' }]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
