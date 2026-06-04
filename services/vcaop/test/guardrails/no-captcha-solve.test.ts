import {
  assertNoCaptchaSolverDependency,
  CaptchaAwareConnectorBase,
} from '../../src/guardrails/no-captcha-solve';
import { CaptchaEncountered } from '../../src/guardrails/errors';

class FakeBrowserConnector extends CaptchaAwareConnectorBase {
  hitCaptcha() {
    return this.onCaptcha('login page');
  }
}

describe('no-captcha-solve (Sec. 0.3 item 3)', () => {
  test('rejects dependencies on CAPTCHA-solving services', () => {
    expect(() => assertNoCaptchaSolverDependency(['express', 'zod'])).not.toThrow();
    expect(() => assertNoCaptchaSolverDependency(['2captcha'])).toThrow(CaptchaEncountered);
    expect(() => assertNoCaptchaSolverDependency(['@vendor/anti-captcha-client'])).toThrow(CaptchaEncountered);
    expect(() => assertNoCaptchaSolverDependency(['capsolver'])).toThrow(CaptchaEncountered);
  });

  test('connector base onCaptcha always throws (no solve path)', () => {
    const c = new FakeBrowserConnector();
    expect(() => c.hitCaptcha()).toThrow(CaptchaEncountered);
  });
});
