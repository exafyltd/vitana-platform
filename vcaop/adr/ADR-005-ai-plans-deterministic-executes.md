# ADR-005: AI plans; deterministic services execute; no generic passthrough tool

**Status:** Accepted (Phase 0, VTID-03532, 2026-08-08)

## Context
The brief draws a hard line: AI may read specs, propose mappings, generate
code/tests, classify failures, and recommend repairs — but must not transfer
funds, settle VTNA, change authoritative inventory, submit irreversible
orders, reveal health data, grant consent, approve KYB, execute refunds, or
change security policy.

## Decision
- The forbidden-action list is enforced in code, not convention: those
  operations exist only as deterministic VCAOP services behind policy
  validation and (where flagged) `human-gate` actions. No MCP tool, agent,
  or generated connector exposes a direct path to them; the existing
  `Validator` pattern (rejects auto-completed human gates, refuses
  unverified commissions) extends to each new action class.
- MCP tools are small, capability-scoped, tenant-aware, and individually
  declared (input/output schema, scopes, risk, read-only/destructive,
  confirmation, idempotency, audit type, policy checks). **No unrestricted
  generic tool that proxies arbitrary internal APIs will ever be added.**
- VTNA: LLMs never calculate or execute authoritative transfers; a
  deterministic ledger service owns balance validation, fees, transfer,
  vesting, reversal, reconciliation, receipts.
- AI-generated artifacts (mappings, transformers, tests, repairs) are
  versioned, reviewable, reversible, sandbox-tested, and gated on
  confidence + certification before activation; material/risky repairs
  require approval.

## Consequences
- "One click" = one authorization + activation decision; consent, KYB,
  legal agreements, CAPTCHA, and irreversible actions always remain human.
- Self-healing may retry/refresh/rebuild-non-material/rollback/degrade/open
  a task; it may never expand scope, accept legal terms, weaken security,
  bypass CAPTCHA, change jurisdiction, disclose more health data, activate
  low-confidence mappings, or execute irreversible financial actions.
