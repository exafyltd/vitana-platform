/**
 * VCAOP — Vitanaland Commerce & Account-Operations Platform.
 * Dev/staging only. Entry barrel; layers are added per the runbook VTID plan (Sec. 6).
 */
export * as guardrails from './guardrails';
export * as policy from './policy';
export * as api from './api';
export * as vault from './vault';
export * as connectors from './connectors';
export * as onboarding from './onboarding';
export * as agents from './agents';
export * as rewards from './rewards';
export * as commerce from './commerce';
export * as observability from './observability';
export * as ui from './ui';
export * as healing from './healing';
// Commerce Mesh layers (Phases 2-7):
export * as canonical from './canonical/model';
export * as factory from './factory';
export * as portal from './portal';
export * as workflows from './workflows';
export * as settlement from './settlement';
// ⛔ health is DORMANT (BLK-009): library-only, never mounted/exposed.
export * as health from './health';
