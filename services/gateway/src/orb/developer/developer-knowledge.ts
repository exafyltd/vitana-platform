/**
 * VTID-04562 — the developer Vitana's starting knowledge (filled in Phase 2).
 */
import { registerDeveloperKnowledgeLoader } from '../profile/work-surface-context';

registerDeveloperKnowledgeLoader(async () => ({
  systemSnapshot: null,
  domainAtlas: null,
  devMemory: null,
  pulse: null,
}));

export {};
