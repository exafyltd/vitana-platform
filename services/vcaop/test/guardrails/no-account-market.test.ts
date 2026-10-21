import {
  assertNoAccountMarketSemantics,
  assertRoutesClean,
} from '../../src/guardrails/no-account-market';
import { AccountMarketViolation } from '../../src/guardrails/errors';

describe('no-account-market (Sec. 0.3 item 5, Sec. 10)', () => {
  test('allows normal routes', () => {
    expect(() => assertNoAccountMarketSemantics('/api/v1/providers')).not.toThrow();
    expect(() => assertNoAccountMarketSemantics('/api/v1/rewards/wallet')).not.toThrow();
  });

  test('rejects account transfer/sale/marketplace semantics', () => {
    expect(() => assertNoAccountMarketSemantics('/api/v1/account-transfer')).toThrow(AccountMarketViolation);
    expect(() => assertNoAccountMarketSemantics('sell_account')).toThrow(AccountMarketViolation);
    expect(() => assertNoAccountMarketSemantics('/account/marketplace')).toThrow(AccountMarketViolation);
  });

  test('rejects points pooling/resale/transfer semantics', () => {
    expect(() => assertNoAccountMarketSemantics('points_pool')).toThrow(AccountMarketViolation);
    expect(() => assertNoAccountMarketSemantics('transfer-points')).toThrow(AccountMarketViolation);
    expect(() => assertNoAccountMarketSemantics('broker_points')).toThrow(AccountMarketViolation);
  });

  test('assertRoutesClean scans a route table', () => {
    expect(() => assertRoutesClean(['/a', '/b', '/c'])).not.toThrow();
    expect(() => assertRoutesClean(['/ok', '/miles_pool'])).toThrow(AccountMarketViolation);
  });
});
