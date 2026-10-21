import {
  assertCloudRunFlags,
  assertStepWithinTimeout,
  assertJobWithinTimeout,
  assertWithinProviderCallCap,
  assertWithinSpendCeiling,
  CLOUD_RUN_CAPS,
  TIMEOUT_CAPS,
} from '../../src/guardrails/cost-guard';
import { CostCapExceeded } from '../../src/guardrails/errors';

describe('cost-guard (Sec. 0.5)', () => {
  test('cloud run flags within caps pass', () => {
    expect(() =>
      assertCloudRunFlags({ maxInstances: 2, concurrency: 20, timeoutSeconds: 300, memoryMi: 512, cpu: 1 }),
    ).not.toThrow();
  });

  test('any flag over cap throws', () => {
    expect(() =>
      assertCloudRunFlags({ ...CLOUD_RUN_CAPS, maxInstances: 3 }),
    ).toThrow(CostCapExceeded);
    expect(() =>
      assertCloudRunFlags({ ...CLOUD_RUN_CAPS, memoryMi: 1024 }),
    ).toThrow(CostCapExceeded);
  });

  test('cost cap breach is Tier-B', () => {
    try {
      assertCloudRunFlags({ ...CLOUD_RUN_CAPS, cpu: 4 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CostCapExceeded);
      expect((e as CostCapExceeded).tierB).toBe(true);
    }
  });

  test('timeouts', () => {
    expect(() => assertStepWithinTimeout(TIMEOUT_CAPS.connectorStepMs - 1)).not.toThrow();
    expect(() => assertStepWithinTimeout(TIMEOUT_CAPS.connectorStepMs + 1)).toThrow(CostCapExceeded);
    expect(() => assertJobWithinTimeout(TIMEOUT_CAPS.wholeJobMs + 1)).toThrow(CostCapExceeded);
  });

  test('provider daily call cap', () => {
    expect(() => assertWithinProviderCallCap('amazon', 99, 1)).not.toThrow();
    expect(() => assertWithinProviderCallCap('amazon', 100, 1)).toThrow(CostCapExceeded);
    expect(() => assertWithinProviderCallCap('amazon', 0, 5, 3)).toThrow(CostCapExceeded);
  });

  test('spend ceiling', () => {
    expect(() => assertWithinSpendCeiling(10)).not.toThrow();
    expect(() => assertWithinSpendCeiling(26)).toThrow(CostCapExceeded);
  });
});
