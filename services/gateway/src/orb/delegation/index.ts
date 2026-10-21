/**
 * BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Public entrypoint for the AI-to-AI
 * delegation layer. orb-live.ts and future tool handlers import from here.
 *
 * Nothing in this module depends on orb-live.ts — the layer is transport-
 * agnostic and can be called from any surface (voice, chat, admin tooling).
 */
export * from './types';
export { executeDelegation } from './execute';
export { routeDelegation } from './router';
export { listActiveProviders, loadUserCredential } from './credentials';
export { adaptForDelivery, normalizeForVoice } from './response-adapter';
export { buildProviderPrompt } from './context-builder';
export { checkBudget } from './budget';
export { logUsage, computeCostUsd } from './usage';
export { getProvider, listProviders } from './providers';
