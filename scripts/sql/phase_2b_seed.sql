BEGIN;

INSERT INTO crew_memory (key, value, aliases, scope, expires_at) VALUES
  ('phase_2b.architecture', '/phase_2b/00_PHASE-2B-ARCHITECTURE.md', '["system-diagram","architecture","P2B-arch"]', 'global', NULL),
  ('phase_2b.master_index', '/phase_2b/01_MASTER_INDEX.md', '["entry-point","master-index","P2B-start"]', 'global', NULL),
  ('phase_2b.final_report', '/phase_2b/02_PHASE-2B-FINAL-REPORT.md', '["final-report","phase2b-report"]', 'global', NULL),
  ('phase_2b.human_loop', '/phase_2b/03_HUMAN-LOOP-INTEGRATION.md', '["chat-commands","human-loop"]', 'global', NULL),
  ('phase_2b.sign_off', '/phase_2b/04_SIGN-OFF-CHECKLIST.md', '["approvals","sign-off"]', 'global', NULL),
  ('phase_2b.ops_handoff', '/phase_2b/05_OPERATIONS-HANDOFF.md', '["ops","handoff","runbook"]', 'global', NULL),
  ('phase_2b.services', '/phase_2b/06_SERVICES_INVENTORY.md', '["services","inventory"]', 'global', NULL),
  ('phase_2b.jobs', '/phase_2b/07_AUTONOMY_JOBS_SPEC.md', '["jobs","autonomy"]', 'global', NULL),
  ('phase_2b.governance', '/phase_2b/08_GOVERNANCE_TEMPLATE_COMPLIANCE.md', '["template","compliance"]', 'global', NULL),
  ('phase_2b.tenancy', '/phase_2b/09_MULTI_TENANCY_RLS.md', '["multi-tenancy","RLS"]', 'global', NULL),
  ('phase_2b.finance', '/phase_2b/10_FINANCIAL_CONTROLS_BUDGETS.md', '["finance","budgets"]', 'global', NULL),
  ('phase_2b.monitoring', '/phase_2b/11_MONITORING_ALERTING.md', '["monitoring","alerting"]', 'global', NULL),
  ('phase_2b.commands', '/phase_2b/12_CHAT_COMMANDS_APPROVALS.md', '["commands","approvals"]', 'global', NULL),
  ('phase_2b.incidents', '/phase_2b/13_INCIDENT_RESPONSE_ROLLBACK.md', '["incidents","rollback"]', 'global', NULL),
  ('phase_2b.gameday', '/phase_2b/14_GAMEDAY_RESILIENCE_TESTS.md', '["gameday","resilience"]', 'global', NULL),
  ('phase_2b.release', '/phase_2b/15_RELEASE_TAGGING_PROCESS.md', '["release","tagging"]', 'global', NULL),
  ('phase_2b.adrs', '/phase_2b/16_ADRS_INDEX.md', '["adrs","decisions"]', 'global', NULL),
  ('phase_2b.runbooks', '/phase_2b/17_RUNBOOKS_INDEX.md', '["runbooks","ops"]', 'global', NULL),
  ('phase_2b.onboarding', '/phase_2b/18_ENGINEER_ONBOARDING_30MIN.md', '["onboarding","engineer"]', 'global', NULL),
  ('phase_2b.security', '/phase_2b/19_SECURITY_PRIVACY_DLP.md', '["security","privacy","DLP"]', 'global', NULL),
  ('phase_2b.qa_docs', '/phase_2b/20_QA_DOC_GUARDRAILS.md', '["qa","docs"]', 'global', NULL)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    aliases = EXCLUDED.aliases,
    scope = EXCLUDED.scope,
    expires_at = EXCLUDED.expires_at;

COMMIT;
