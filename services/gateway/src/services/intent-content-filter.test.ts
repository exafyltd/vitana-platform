import { checkIntentContent } from './intent-content-filter';
import type { IntentKind } from './intent-classifier';

describe('checkIntentContent', () => {
  it('should not trigger false positives on phone numbers or arbitrary 13+ digit numbers', () => {
    const result = checkIntentContent({
      kind: 'commercial_buy' as unknown as IntentKind,
      title: 'Call me at +1 800-555-0199',
      scope: 'Or random digits 123456789012345'
    });
    expect(result.reasons.some(r => r.includes('credit_card'))).toBe(false);
  });

  it('should detect a 16-digit valid Visa card number formatted with spaces', () => {
    const result = checkIntentContent({
      kind: 'partner_seek' as unknown as IntentKind,
      title: 'My card is',
      scope: '4111 1111 1111 1111'
    });
    expect(result.reasons).toContain('pii_credit_card_blocked_strict');
  });

  it('should ignore a 16-digit string that fails the Luhn check', () => {
    const result = checkIntentContent({
      kind: 'commercial_buy' as unknown as IntentKind,
      title: 'Card 4111 1111 1111 1112',
      scope: 'Buying goods'
    });
    expect(result.reasons.some(r => r.includes('credit_card'))).toBe(false);
  });

  it('should return ok: false with pii_credit_card_blocked_strict for partner_seek', () => {
    const result = checkIntentContent({
      kind: 'partner_seek' as unknown as IntentKind,
      title: 'Here is my visa',
      scope: '4111-1111-1111-1111'
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('pii_credit_card_blocked_strict');
  });

  it('should return ok: true with pii_credit_card_warning for commercial_buy', () => {
    const result = checkIntentContent({
      kind: 'commercial_buy' as unknown as IntentKind,
      title: 'Here is my visa',
      scope: '4111-1111-1111-1111'
    });
    expect(result.ok).toBe(true);
    expect(result.reasons).toContain('pii_credit_card_warning');
  });
});