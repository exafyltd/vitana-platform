// plan sparring-eu-guard, C1 + C3(a)(b): the DeepSeek direct-API last-resort tier is off unless the flag is exactly 'true'.
import { isPlanSparringDeepseekFallbackEnabled } from '../../src/constants/llm-defaults';

const KEY = 'PLAN_SPARRING_DEEPSEEK_FALLBACK_ENABLED';

describe('plan sparring DeepSeek last-resort tier (sparring-eu-guard C1)', () => {
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('C3(a): unset flag -> tier off', () => {
    delete process.env[KEY];
    expect(isPlanSparringDeepseekFallbackEnabled()).toBe(false);
  });

  it("C3(b): flag exactly 'true' -> tier on", () => {
    process.env[KEY] = 'true';
    expect(isPlanSparringDeepseekFallbackEnabled()).toBe(true);
  });

  it.each(['false', '', 'TRUE', '1', 'yes'])("flag '%s' -> tier off", (v) => {
    process.env[KEY] = v;
    expect(isPlanSparringDeepseekFallbackEnabled()).toBe(false);
  });
});
