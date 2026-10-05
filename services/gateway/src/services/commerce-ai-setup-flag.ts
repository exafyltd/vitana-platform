/**
 * VTID-04838 / VTID-04840 — the Commerce AI setup switch, on its own so the
 * ORB tool catalog and greeting can read it without loading the setup
 * service (website reader, LLM router, partner routes).
 */
export function isCommerceAiSetupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMMERCE_AI_SETUP_ENABLED === 'true';
}
