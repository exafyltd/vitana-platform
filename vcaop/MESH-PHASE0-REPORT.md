# Vitanaland AI Commerce Mesh — Phase 0 Report (VTID-03532)

**Date:** 2026-08-08
**Branch:** `claude/vitana-commerce-mesh-arch-opeet7`
**Status:** Phase 0 complete. No production code changed in this phase.

This report is the Phase 0 deliverable set for evolving VCAOP into the
Vitanaland AI Commerce Mesh: verified current-state, implementation-gap
analysis, canonical model proposal, threat model, migration and
compatibility plan, test baseline, and blocker updates. Architecture
decision records live in `vcaop/adr/`.

---

## 1. Verified current state (evidence-checked, not doc-trusted)

Every claim below was verified against code on this branch (HEAD `33268ea`),
not just against `CURRENT-STATE.md`.

### 1.1 VCAOP library (`services/vcaop/`) — VERIFIED PRESENT AND GREEN

| Layer | What exists | Verified how |
|---|---|---|
| Guardrails (`src/guardrails/`) | `policy-engine` (default-deny), `env-boundary`, `no-credential-store`, `no-pii-leak`, `human-gate` (KYB/LIVENESS/CAPTCHA/PAYOUT_BANK_LINK/PRIVILEGE_ESCALATION/IRREVERSIBLE_SUBMIT/TRANSFER/REAUTH), `no-captcha-solve`, `single-identity`, `no-account-market`, `loyalty-guard`, `cost-guard` | 33-suite jest run; guardrail tests pass |
| Connectors (`src/connectors/`) | `Connector` interface + `BaseConnector` that routes register/verify/operate/healthCheck through env-boundary → policy-engine → human-gate → CAPTCHA guard BEFORE adapter hooks; `ApiConnector`, `OAuthConnector` (token lifecycle, refresh-on-401, revocation→degraded+REAUTH task), `BrowserConnector` (swappable driver, PII-scrubbed artifacts, CAPTCHA→human task, irreversible submit→human gate), `ManualConnector` | source + tests |
| Agents (`src/agents/`) | `Conductor.planJob` (policy→tier+steps), `Worker.executePlan` (human-gated steps halt, never skipped), `Validator` (rejects auto-completed human gates; refuses commission confirm without verified postback), `Monetization.selectRoute` (never cashback on `affiliate_cashback_allowed=false`), llm-router (PLANNER→claude, WORKER→gemini-flash, VALIDATOR→claude) | source + tests |
| Vault (`src/vault/`) | `SecretStore` interface, RFC-4226/6238 TOTP (verified against RFC vectors), scoped short-lived credential issuance, hashed single-use recovery codes, alias mailbox + OTP extraction | source + tests |
| Commerce (`src/commerce/`) | Universal Cart + checkout ladder UCP → Shopify-agent → Violet → Rye → Skyvern; multi-merchant routing; non-dismissible FTC disclosure; per-merchant SubID | source + tests |
| Rewards (`src/rewards/`) | aggregator adapter, attribution (postback → commission_event → rewards_ledger pending→confirmed→reversed with clawback), direct registration, loyalty (read-only, credential-free) | source + tests |
| API (`src/api/`) | Express router for /providers /policies /accounts /jobs /tasks /approvals /affiliate-programs /rewards /cart /audit over `Repository`+`OasisSink`; `PrismaRepository.writeWithEvent` (read-model write + OASIS event in ONE `$transaction`); generated OpenAPI 3.0.3 at `GET /api/v1/vcaop/openapi.json`; responses strip `*_ref`/secrets | source + tests |
| Healing (`src/healing/`) | `SelfHealingOrchestrator` (detect→diagnose→bounded escalating ladder→verify→recover/escalate; guardrail failures never auto-healed — immediate escalate+freeze), `invariantProbe`, `runHealthAndHeal` | source + tests |
| UI presenters (`src/ui/`) | Framework-agnostic view-models (wallet, cart, admin catalog/policy, ops/approvals) with `stripSensitive` | source + tests |
| IAM | 20 RLS policies over 16 tables (`prisma/migrations/20260605_vcaop_iam_roles_0001/`), verified up→down→up on ephemeral PG | migration files + `test/iam` |

### 1.2 Test baseline (run on this branch, 2026-08-08)

```
services/vcaop: npx tsc --noEmit  → clean
services/vcaop: npx jest          → 33/33 suites, 184/184 tests PASS (7.25s)
```

This is the regression floor for every Mesh phase: existing VCAOP tests
must remain green (Definition-of-Done item 17).

### 1.3 Prisma schema (`prisma/schema.prisma`) — 16 VCAOP models present

`BusinessIdentity`, `Provider` (policy JSON, connector_mode), `ProviderAccount`
(status ladder, credential **refs only**), `ProvisioningJob`/`JobStep`/
`JobAttempt`/`JobArtifact` (scrubbed), `HumanTask`, `AccountHealthSnapshot`,
`AffiliateProgram`, `CommissionEvent`, `RewardsLedger`, `UserRewardLink`
(schema-enforced: no password field), `CartOrder`, `MerchantRoute`,
`Disclosure` — plus OASIS `OasisEvent`/`VtidLedger`/`ProjectionOffset`.

**Caution carried from VTID-03486:** 103 tables are declared by migrations in
this repo and absent from production. Any Mesh migration must be applied via
the working paths (Supabase MCP / Management API), and its presence verified,
not assumed from a green workflow.

### 1.4 Live gateway integration — MORE is live than `CURRENT-STATE.md` records

Verified in `services/gateway/src`:

- `routes/vcaop.ts` mounted at `/api/v1/vcaop`: `/providers`,
  `/affiliate-programs`, `/shop`, `/affiliate-link` (per-user SubID +
  `subid_map`), `/wallet`, `/commissions` (+ confirm/reverse),
  `/onboarding/inbox`, `/onboarding/batch`, `/tasks/:id/complete`.
- `routes/vcaop-postback.ts`: PUBLIC key-verified Admitad postback
  (idempotent commission + rewards pending→confirmed|reversed), mounted
  before the authed router.
- `routes/click-redirect.ts` (`/r/:id`): affiliate 302 with stamped links.
- **Marketplace-sync layer** (`services/marketplace-sync/`): handwritten
  provider adapters for **admitad, amazon, awin, cj, rakuten, shopify** +
  `awin-order-sync`, `awin-conversions`, `shopify-sync` routes. This layer
  postdates `CURRENT-STATE.md`'s last entry (2026-06-29) — the state file is
  stale; corrected in this phase.
- Live network status: **Admitad live** (verified token, gotolink, subid
  attribution); Awin/CJ/Rakuten/Shopify sync adapters present; eBay paused
  (EPN declined — BLK-004); Amazon.ae pivot pending bank account (BLK-005).

### 1.5 MCP components — both are internal; neither is the public gateway

- `services/mcp/gateway/`: internal connector hub (GitHub/Supabase/
  Perplexity/Linear/Context7/Testsprite) for the platform's own agents.
  **Not** MCP-protocol-speaking to external AI clients; no OAuth; no tenancy.
- `mcp/vitana-work/`: stdio MCP server for Claude Code task pickup
  (internal dev tooling).
- `services/mcp-gateway/`: older internal experiment.

Confirms the brief's premise: the public multi-tenant MCP/OAuth gateway
(`mcp.vitanaland.com/mcp`) **does not exist and must be a new, separate,
production-grade service** that reuses VCAOP internals — not an exposure of
any of the above. (ADR-004.)

### 1.6 Adjacent assets reusable by the Mesh

- OASIS event ledger + projector (audit spine).
- Gateway LLM router with per-stage provider policy incl. Bedrock adapter
  with vision+tool-calling (§2b) — the "AI plans" layer can route through it.
- Supabase Auth (dual JWT) + RLS conventions; `subid_map`; wallet/rewards
  surfaces in `vitana-v1`.
- Self-healing patterns + OASIS alert workflows over PostgREST.

---

## 2. Implementation-gap report (brief → codebase)

| # | Brief requirement | Current state | Gap class |
|---|---|---|---|
| 1 | VCAOP execution engine + guardrails | **Exists, green** | Reuse as-is |
| 2 | Canonical Commerce & Data Graph (versioned, provenance, jurisdiction, classification, mapping confidence) | Absent — per-provider ad-hoc shapes in marketplace-sync; Prisma models cover commerce core but no canonical envelope/versioning | **Build** (Phase 0 proposal §3; schema Phase 2) |
| 3 | ConnectorManifest + ConnectorFactory (compiler-driven) | Absent — connectors are handwritten classes; marketplace-sync providers are handwritten adapters (6 of them: exactly the pattern the factory replaces) | **Build** (Phase 2) |
| 4 | AI Integration Builder (discover→map→score→generate→sandbox-test→certify→activate→drift→repair) | Absent. Building blocks exist: Conductor/Worker/Validator, healing orchestrator, llm-router | **Build** (Phases 2/5) |
| 5 | Public multi-tenant MCP/OAuth gateway (`mcp.vitanaland.com/mcp`, OAuth 2.1 + PKCE, DCR, streamable HTTP) | Absent (see §1.5) | **Build** (Phase 1) |
| 6 | Capability-scoped MCP tools (read + write, per-tool scopes/risk/confirmation/idempotency) | Absent; underlying data exists via `/api/v1/vcaop/*` + discover routes | **Build** (Phase 1 read, Phase 6 write) |
| 7 | Partner Portal onboarding (connect-business wizard, one-approval activation, connection states) | Absent; KYB human-task flow + onboarding inbox exist as primitives; frontend repo constraint = BLK-003 (view-model pattern already established) | **Build** (Phase 3) |
| 8 | Durable workflows (idempotent commands/consumption, sagas, DLQ, replay, workflow versioning) | Partial primitives: ProvisioningJob/JobStep/JobAttempt + idempotent postbacks; no generic workflow engine, no DLQ, no replay, no compensation framework | **Build** (Phase 4) |
| 9 | Commerce use cases 10.1–10.4 | Affiliate flow (10.3) live end-to-end mock + Admitad live; checkout ladder exists (mock); order automation (10.2) and agent-ops (10.4) partial via agents layer | **Extend** (Phase 6) |
| 10 | Insurance / health attestations | Absent entirely (correct — Phase 7, gated on independent privacy review) | **Build last** (Phase 7) |
| 11 | VTNA settlement | Absent in VCAOP; rewards ledger is EUR-denominated. Deterministic ledger required | **Build** (Phase 6; legal review blocker) |
| 12 | DB extensions (§13 of brief: ~23 models) | Absent; existing 16 models are the substrate to relate to | **Build** (Phase 2+, reversible migrations) |
| 13 | Self-healing extensions (schema drift, mapping failure, workflow backlog, reconciliation) | Orchestrator + ladder exist; detectors for the new failure classes absent | **Extend** (Phase 5) |
| 14 | OpenAPI from authoritative routes | Exists for VCAOP core (`openapi.ts`); must extend per phase | Extend |

**Conclusion:** nothing in the brief conflicts with what exists. The brief is
an extension program on a healthy substrate. No second execution platform is
needed or will be built.

---

## 3. Canonical Commerce & Data Graph — proposal (v1)

Design (schema lands in Phase 2 as `CanonicalEntity`-namespaced Prisma models
+ Zod schemas in `services/vcaop/src/canonical/`):

- **Envelope, every canonical record:** `schema_version` (semver; additive
  minor, breaking major), `tenant_id`, `entity_type`, `entity_id`,
  `source_connector_id`, `source_native_id`, `provenance`
  (connector/manifest version/mapping version/timestamp), `jurisdiction`,
  `data_classification` (`public|commercial|personal|sensitive|health`),
  `mapping_confidence` (0–1), `valid_from/valid_to`.
- **Entity set (v1):** Business, UserIdentity/DelegatedIdentity, Product,
  Service, Offer, Pricing, Inventory, Customer, Consent, DataGrant,
  HealthDataAttestation*, InsuranceQuote*, InsurancePolicy*, Cart,
  CheckoutSession, Order, Payment, Invoice, Fulfilment, Shipment, Return,
  Refund, AffiliateAttribution, Commission, Reward, VtnaSettlement,
  AuditEvent. (*health-classified: separate storage + access policy, never in
  general query paths — Phase 7 only.)
- **Mapping direction:** every partner maps **once** to canonical; partner ↔
  partner exchange is always canonical-mediated. Mappings are versioned rows
  (`SchemaMapping` + `MappingDecision` with confidence + reviewer), never
  inline code-only.
- **Backward compatibility:** consumers declare the major version they read;
  the normalizer up-converts minor versions; breaking changes require a new
  major + dual-write window.
- **Reuse:** existing Prisma commerce models become the *authoritative
  read-models*; canonical records reference them (e.g. canonical Order ↔
  `cart_order`), rather than duplicating state.

---

## 4. Threat model (summary — full mitigations tracked per phase)

| Threat | Vector | Mitigation (existing → planned) |
|---|---|---|
| Token/scope abuse by AI client | ChatGPT/Claude connector calls beyond user intent | OAuth 2.1 + PKCE, granular scopes, per-tool scope checks, short-lived tokens, audience validation, tool confirmation metadata for writes (Phase 1); no generic passthrough tool (ADR-005) |
| Tenant crossing | Multi-tenant public gateway | Tenant context bound into token; ownership checks per tool; RLS beneath; tenant-isolation tests (Phase 1 gate) |
| Prompt-injected tool misuse | Malicious product/partner data steering AI clients | Tools return typed data, no instructions; write tools require confirmation + idempotency keys; irreversible actions human-gated in VCAOP regardless of caller |
| Credential leakage | Manifests, logs, LLM prompts, OASIS | Existing `no-credential-store` + `no-pii-leak` guardrails extended to manifests (secret **references** only — brief §4); secret-leak tests per phase |
| Malicious/compromised partner system | Connector ingesting hostile schemas/events | Sandbox-only discovery, mapping confidence gates, certification before activation, webhook signature verification, rate limits, circuit breakers |
| Generated-code supply chain | AI-generated transformers | Generated code is versioned, reviewed, sandbox-contract-tested, tied to manifest version, reversible (Phase 2/5); low-confidence mappings never auto-activate |
| Health-data exposure | Insurance flows | Purpose-bound tools only, derived attestations not raw records, separate storage/policy, consent receipts, no health data in prompts/logs; Phase 7 blocked on independent review (BLK-009) |
| Financial abuse | VTNA settlement, refunds | Deterministic ledger services only; LLM may never compute/execute transfers; spending limits, human gates on irreversible/financial actions (existing `human-gate` categories extended) |
| Replay/duplication | Webhooks, MCP write calls | Idempotency keys, dedup on event consumption, effectively-once via state machines + reconciliation (Phase 4) |
| Availability/cost | Public endpoint abuse | Rate limiting, usage metering, cost-guard extension, anomaly detection |

Default-deny stands everywhere: unknown provider, unknown tool, unknown
scope, unknown tenant → refuse.

---

## 5. Migration & compatibility plan

1. **Schema:** all Mesh models are additive Prisma models with reversible
   migrations (up + down verified on ephemeral PG, same discipline as
   `20260604_vcaop_ctrl_schema_0002`). No existing model is altered
   destructively; new FKs reference existing tables. RLS policies added per
   the `iam_roles_0001` pattern. Applied-vs-declared verified per VTID-03486.
2. **Code:** new modules land beside existing ones (`src/canonical/`,
   `src/factory/`, `src/workflows/`); `Connector` interface is **unchanged** —
   the factory *emits* connectors implementing it, so every guardrail path is
   inherited, not reimplemented (ADR-002). Handwritten marketplace-sync
   providers keep working; they are re-expressed as manifests incrementally
   with contract tests proving parity before any cutover.
3. **API:** `/api/v1/vcaop/*` remains stable; new resources are added, none
   removed. OpenAPI regenerated per phase.
4. **Public MCP gateway:** new service (`services/vcaop-mcp/` — name final at
   Phase 1), deployed dev-first behind the existing staging-first pipeline;
   `mcp.vitanaland.com` DNS + OAuth AS provisioning are human/Tier-B
   (BLK-006/007). Production stays disabled until DoD item 18 is explicitly
   satisfied.
5. **Compatibility tests:** each phase's CI adds backward-compat tests; the
   184-test baseline is the non-negotiable floor.

---

## 6. Delivery plan mapping (phases → VTIDs)

Phase 0 = this report (VTID-03532). Each subsequent phase self-allocates its
own VTID(s) at start, per CLAUDE.md §4.1. Recommended next: **Phase 1 —
public read-only MCP** (foundation + OAuth + read tools + per-tool authz +
MCP Inspector tests), because it is independently valuable, exercises no
irreversible commerce paths, and forces the tenancy/scope model everything
else builds on.

---

## 7. Blockers (delta — full register in BLOCKERS.md)

Existing BLK-001…005 remain accurate and unchanged. New this phase:
BLK-006 (mcp.vitanaland.com infra/DNS/TLS — Tier B), BLK-007 (OAuth 2.1
authorization-server decision + client registration for ChatGPT/Claude —
security-tier decision), BLK-008 (Partner Portal frontend repo — same class
as BLK-003), BLK-009 (Phase 7 independent privacy/consent review),
BLK-010 (VTNA legal/regulatory review before settlement goes beyond
sandbox).
