INSERT INTO vtid_ledger (vtid, layer, module, status, title, summary, created_at, updated_at)
VALUES
  (
    'ADM-GOVRN-0060',
    'ADM',
    'GOVRN',
    'SCHEDULED',
    'Governance Engine foundation & rule registry',
    'Design and implement the core Governance Rule Engine in OASIS: store rules (L1–L4), load them from JSON, and expose a validation hook that can allow or block tasks before deployment.',
    NOW(),
    NOW()
  ),
  (
    'ADM-GOVRN-0061',
    'ADM',
    'GOVRN',
    'SCHEDULED',
    'Governance Screen v1 in Command Hub',
    'Create the Governance tab in Command Hub that lists all governance rules (L1–L4 and future), shows severity/enforcement, and opens a drawer with full details and recent violations for each rule.',
    NOW(),
    NOW()
  ),
  (
    'ADM-GOVRN-L2',
    'ADM',
    'GOVRN',
    'SCHEDULED',
    'SYS-RULE-DEPLOY-L2: Pre-deployment diagnostics',
    'Implement L2 so any task that touches Supabase or OASIS must attach live schema + event diagnostics (diagnostic_verified + diagnostic_log) before deployment, otherwise the Governance Engine blocks it.',
    NOW(),
    NOW()
  ),
  (
    'ADM-GOVRN-L3',
    'ADM',
    'GOVRN',
    'SCHEDULED',
    'SYS-RULE-DEPLOY-L3: Canonical schema & naming',
    'Implement L3 so all database and ORM usage goes through a canonical schema registry (vtid_ledger, oasis_events, etc.). Any unregistered or mis-cased table/model name triggers a governance violation and blocks deployment.',
    NOW(),
    NOW()
  ),
  (
    'ADM-GOVRN-L4',
    'ADM',
    'GOVRN',
    'SCHEDULED',
    'SYS-RULE-DEPLOY-L4: Playbook reuse enforcement',
    'Implement L4 so autonomous agents must reuse existing playbooks in AUTOPILOT mode and only use Exploration mode when no playbook exists, producing a new playbook at the end instead of rediscovering solutions.',
    NOW(),
    NOW()
  ),
  (
    'ADM-GOVRN-0065',
    'ADM',
    'GOVRN',
    'SCHEDULED',
    'Governance → Task Board sync job',
    'Build a sync job that reads governance rules from OASIS and ensures each has a VTID row in vtid_ledger with SCHEDULED/IN_PROGRESS/COMPLETED, so every governance rule appears as a card on the Vitana Task Board.',
    NOW(),
    NOW()
  )
ON CONFLICT (vtid) DO UPDATE
SET
  layer      = EXCLUDED.layer,
  module     = EXCLUDED.module,
  status     = EXCLUDED.status,
  title      = EXCLUDED.title,
  summary    = EXCLUDED.summary,
  updated_at = NOW();
