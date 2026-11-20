import { classifyClient } from '../src/services/client-identity/classify';

describe('classifyClient', () => {
  it('classifies native iOS', () => {
    expect(classifyClient('native/ios/1.4.0')).toBe('native');
  });
  it('classifies native Android', () => {
    expect(classifyClient('native/android/2.0.1')).toBe('native');
  });
  it('classifies the test platform as native', () => {
    expect(classifyClient('native/test/0.0.0')).toBe('native');
  });
  it('treats a missing header as web', () => {
    expect(classifyClient(undefined)).toBe('web');
    expect(classifyClient(null)).toBe('web');
    expect(classifyClient('')).toBe('web');
  });
  it('treats a malformed header as web', () => {
    for (const v of ['native', 'native/', 'native/ios', 'native/ios/', 'native//1.0', 'web/ios/1.0',
      'native/ios/1.0/extra', ' native/ios/1.0', 'native/ios/1 0', 'native/ios/1.0\n', 'Native/ios/1.0', 'x'.repeat(500)]) {
      expect(classifyClient(v)).toBe('web');
    }
  });
  it('treats an unknown platform as web', () => {
    expect(classifyClient('native/windows/1.0.0')).toBe('web');
    expect(classifyClient('native/iOS/1.0.0')).toBe('web');
  });
  it('classifies a well-formed but unknown (future) version as native', () => {
    expect(classifyClient('native/ios/999.0.0')).toBe('native');
    expect(classifyClient('native/android/1.0.0-beta.3+45')).toBe('native');
  });
  it('treats an unparseable version as web', () => {
    expect(classifyClient('native/ios/!!')).toBe('web');
    expect(classifyClient('native/ios/' + '1'.repeat(80))).toBe('web');
  });
  it('uses the first value of an array header and ignores non-strings', () => {
    expect(classifyClient(['native/ios/1.0.0', 'x'])).toBe('native');
    expect(classifyClient([] as string[])).toBe('web');
    expect(classifyClient(42 as unknown as string)).toBe('web');
  });
});
