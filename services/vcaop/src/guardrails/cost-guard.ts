/**
 * Cost guard (runbook Sec. 0.5, Sec. 3).
 *
 * Enforces the dev cost/resource caps. A breach throws CostCapExceeded, which is
 * Tier-B: escalate (ESCALATIONS.md), never silently raise the cap.
 */
import { CostCapExceeded } from './errors';

/** Cloud Run dev caps (Sec. 0.5). */
export const CLOUD_RUN_CAPS = Object.freeze({
  maxInstances: 2,
  concurrency: 20,
  timeoutSeconds: 300,
  memoryMi: 512,
  cpu: 1,
});

/** Job/step timeout caps in milliseconds (Sec. 0.5). */
export const TIMEOUT_CAPS = Object.freeze({
  connectorStepMs: 15 * 60 * 1000, // 15 min
  wholeJobMs: 2 * 60 * 60 * 1000, // 2 h
});

/** Default per-provider external call cap per day (Sec. 0.5). */
export const DEFAULT_PROVIDER_DAILY_CALL_CAP = 100;

/** Default dev incremental spend ceiling in USD/day (Sec. 0.5). */
export const SPEND_CEILING_USD_PER_DAY = 25;

export interface CloudRunFlags {
  maxInstances: number;
  concurrency: number;
  timeoutSeconds: number;
  memoryMi: number;
  cpu: number;
}

/** Throw if any Cloud Run flag exceeds the dev cap (Sec. 0.5). */
export function assertCloudRunFlags(flags: CloudRunFlags): void {
  const breaches: string[] = [];
  if (flags.maxInstances > CLOUD_RUN_CAPS.maxInstances) breaches.push(`max-instances ${flags.maxInstances}>${CLOUD_RUN_CAPS.maxInstances}`);
  if (flags.concurrency > CLOUD_RUN_CAPS.concurrency) breaches.push(`concurrency ${flags.concurrency}>${CLOUD_RUN_CAPS.concurrency}`);
  if (flags.timeoutSeconds > CLOUD_RUN_CAPS.timeoutSeconds) breaches.push(`timeout ${flags.timeoutSeconds}>${CLOUD_RUN_CAPS.timeoutSeconds}`);
  if (flags.memoryMi > CLOUD_RUN_CAPS.memoryMi) breaches.push(`memory ${flags.memoryMi}Mi>${CLOUD_RUN_CAPS.memoryMi}Mi`);
  if (flags.cpu > CLOUD_RUN_CAPS.cpu) breaches.push(`cpu ${flags.cpu}>${CLOUD_RUN_CAPS.cpu}`);
  if (breaches.length > 0) {
    throw new CostCapExceeded(`Cloud Run flags exceed dev caps (Sec. 0.5): ${breaches.join(', ')}`);
  }
}

/** Throw if a planned/observed step duration exceeds the connector-step cap. */
export function assertStepWithinTimeout(elapsedMs: number): void {
  if (elapsedMs > TIMEOUT_CAPS.connectorStepMs) {
    throw new CostCapExceeded(
      `Connector step ${Math.round(elapsedMs / 1000)}s exceeds ${TIMEOUT_CAPS.connectorStepMs / 1000}s cap (Sec. 0.5)`,
    );
  }
}

/** Throw if a planned/observed job duration exceeds the whole-job cap. */
export function assertJobWithinTimeout(elapsedMs: number): void {
  if (elapsedMs > TIMEOUT_CAPS.wholeJobMs) {
    throw new CostCapExceeded(
      `Job ${Math.round(elapsedMs / 60000)}min exceeds ${TIMEOUT_CAPS.wholeJobMs / 60000}min cap (Sec. 0.5)`,
    );
  }
}

/** Throw if (current + requested) external calls would exceed the per-provider daily cap. */
export function assertWithinProviderCallCap(
  provider: string,
  currentCount: number,
  requested = 1,
  cap = DEFAULT_PROVIDER_DAILY_CALL_CAP,
): void {
  if (currentCount + requested > cap) {
    throw new CostCapExceeded(
      `Provider "${provider}" external call cap reached: ${currentCount}+${requested} > ${cap}/day (Sec. 0.5)`,
    );
  }
}

/** Throw if estimated incremental dev spend would exceed the daily ceiling. */
export function assertWithinSpendCeiling(estimatedUsd: number, ceiling = SPEND_CEILING_USD_PER_DAY): void {
  if (estimatedUsd > ceiling) {
    throw new CostCapExceeded(
      `Estimated dev spend $${estimatedUsd}/day exceeds $${ceiling}/day ceiling — HALT/Tier-B (Sec. 0.5)`,
    );
  }
}
