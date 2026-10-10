/**
 * VTID-04814 — what a developer says to Vitana on the Command Hub, and the
 * Command Hub screen that answers it. Run against the registry resolver with
 * surface 'command-hub' (test/navigation/command-hub-screens.test.ts), and
 * embedded by build-embeddings.ts so CI resolves them offline.
 *
 * Adding a Command Hub tab or moving one: add or update cases here in the
 * same PR, exactly as golden-set.ts is for member screens.
 *
 * Known limit: the Command Hub screens are English only (a developer tool,
 * English by design), so German works where the words resemble the English
 * names ("Autopilot Live", "VTID-Ledger") and not where they do not
 * ("Freigaben" for Approvals does not reach the Approvals tab).
 */
export interface CommandHubCase {
  say: string;
  lang: 'en' | 'de';
  /** Acceptable screens (a sibling tab of the same view is sometimes fine). */
  expect: string[];
}

export const COMMAND_HUB_CASES: CommandHubCase[] = [
  { say: 'open autopilot live', lang: 'en', expect: ['DEVHUB.AUTOPILOT.LIVE'] },
  { say: 'show me what the autopilot is running right now', lang: 'en', expect: ['DEVHUB.AUTOPILOT.LIVE', 'DEVHUB.AUTOPILOT.RUNS'] },
  { say: 'take me to the VTID ledger', lang: 'en', expect: ['DEVHUB.OASIS.VTID_LEDGER'] },
  { say: 'open the OASIS events', lang: 'en', expect: ['DEVHUB.OASIS.EVENTS'] },
  { say: 'show me the infrastructure logs', lang: 'en', expect: ['DEVHUB.INFRA.LOGS'] },
  { say: 'open the deployments in infrastructure', lang: 'en', expect: ['DEVHUB.INFRA.DEPLOYMENTS'] },
  { say: 'where can I see the governance rules', lang: 'en', expect: ['DEVHUB.GOVERNANCE.RULES'] },
  { say: 'open the governance violations', lang: 'en', expect: ['DEVHUB.GOVERNANCE.VIOLATIONS'] },
  { say: 'show me the system overview', lang: 'en', expect: ['DEVHUB.OVERVIEW.SYSTEM_OVERVIEW'] },
  // VTID-04887: the four old Overview tabs are redirects now; their ids are
  // formerIds of the screens they redirect to.
  { say: 'open the live metrics', lang: 'en', expect: ['DEVHUB.OPERATOR.DASHBOARD'] },
  { say: 'show me errors and violations on the overview', lang: 'en', expect: ['DEVHUB.GOVERNANCE.VIOLATIONS'] },
  { say: 'open the release feed', lang: 'en', expect: ['DEVHUB.OPERATOR.DEPLOYMENTS', 'DEVHUB.INFRA.DEPLOYMENTS'] },
  { say: 'go to the user management', lang: 'en', expect: ['DEVHUB.ADMIN.USERS'] },
  { say: 'open the tenants admin screen', lang: 'en', expect: ['DEVHUB.ADMIN.TENANTS'] },
  { say: 'open the approvals queue', lang: 'en', expect: ['DEVHUB.COMMAND_HUB.APPROVALS'] },
  { say: 'show me the task board', lang: 'en', expect: ['DEVHUB.COMMAND_HUB.TASKS', 'DEVHUB.OPERATOR.TASK_QUEUE'] },
  { say: 'open the operator event stream', lang: 'en', expect: ['DEVHUB.OPERATOR.EVENT_STREAM'] },
  { say: 'open the runbook', lang: 'en', expect: ['DEVHUB.OPERATOR.RUNBOOK'] },
  { say: 'show me the registered agents', lang: 'en', expect: ['DEVHUB.AGENTS.REGISTERED'] },
  { say: 'open the LLM providers', lang: 'en', expect: ['DEVHUB.INTEGRATIONS.LLM_PROVIDERS'] },
  { say: 'open model routing', lang: 'en', expect: ['DEVHUB.MODELS.ROUTING'] },
  { say: 'show me the test runs', lang: 'en', expect: ['DEVHUB.TESTING.CI_REPORTS', 'DEVHUB.TESTING.RUN_TESTS'] },
  { say: 'open the end to end tests', lang: 'en', expect: ['DEVHUB.TESTING.E2E'] },
  { say: 'open the RLS and access policies', lang: 'en', expect: ['DEVHUB.SECURITY.RLS'] },
  { say: 'show me the audit log', lang: 'en', expect: ['DEVHUB.SECURITY.AUDIT_LOG'] },
  { say: 'open the API inventory', lang: 'en', expect: ['DEVHUB.DOCS.API_INVENTORY'] },
  { say: 'show me the database schemas in the docs', lang: 'en', expect: ['DEVHUB.DOCS.DATABASE_SCHEMAS'] },
  { say: 'open voice self-healing', lang: 'en', expect: ['DEVHUB.VOICE.ISSUES_HEALING'] },
  { say: 'show me the live voice sessions', lang: 'en', expect: ['DEVHUB.VOICE.SESSIONS'] },
  { say: 'open the nova sonic test bench', lang: 'en', expect: ['DEVHUB.VOICE.TEST_BENCH'] },
  { say: 'open the voice supervisor overview', lang: 'en', expect: ['DEVHUB.VOICE.OVERVIEW'] },
  { say: 'show me voice health per tenant', lang: 'en', expect: ['DEVHUB.VOICE.SEGMENTS'] },
  { say: 'open the test contracts', lang: 'en', expect: ['DEVHUB.TESTING.TEST_CONTRACTS'] },
  { say: 'show me the autonomy pulse', lang: 'en', expect: ['DEVHUB.AUTONOMY.AUTONOMY_PULSE'] },
  { say: 'open the conversation tool health', lang: 'en', expect: ['DEVHUB.CONVERSATION.TOOLS'] },
  { say: 'open the commerce overview', lang: 'en', expect: ['DEVHUB.COMMERCE.OVERVIEW'] },
  { say: 'show me the marketplace review queue', lang: 'en', expect: ['DEVHUB.COMMERCE.MARKETPLACE_REVIEW'] },
  { say: 'open the routines catalog', lang: 'en', expect: ['DEVHUB.ROUTINES.CATALOG'] },
  { say: 'öffne Autopilot Live', lang: 'de', expect: ['DEVHUB.AUTOPILOT.LIVE'] },
  { say: 'zeig mir die Infrastruktur-Logs', lang: 'de', expect: ['DEVHUB.INFRA.LOGS'] },
  { say: 'öffne das VTID-Ledger', lang: 'de', expect: ['DEVHUB.OASIS.VTID_LEDGER'] },
  { say: 'zeig mir die Governance-Regeln', lang: 'de', expect: ['DEVHUB.GOVERNANCE.RULES'] },
];
