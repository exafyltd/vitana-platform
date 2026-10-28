# VCAOP - Vitanaland Commerce & Account-Operations Platform
## Autonomous Build Runbook for Claude Code (Rev. 2)

**Audience:** Claude Code (autonomous executor).
**Mode:** Autonomous build, dev/staging only. No human interaction for normal engineering decisions. Must halt and await human approval for the high-stakes categories in Sec. 0.4. Execute as one continuous initiative across as many sessions as required, resuming from state.
**Owner:** Exafy LTD / Vitanaland.
**Target stack:** existing `exafyltd/vitana-platform` monorepo - Gateway (Express/TypeScript on Cloud Run), OASIS event ledger (Supabase Postgres + Prisma), Autopilot multi-agent cluster (conductor / worker-core / validator-core / crewai-gcp / prompt-synth), Cloud Secret Manager, GitHub Actions CI/CD. GCP project `lovable-vitana-vers1`, region `us-central1`.

> Rev. 2 changelog: ASCII-safe punctuation; added hard dev-only environment boundary (0.2); two-tier escalation replacing "zero interruptions" (0.4); cost & resource controls (0.5); branch/commit/deploy permissions (0.6); rollback & recovery requirement (0.7); dependency-realism / verify-before-build rule (0.8); explicit PII bans across logs/prompts/traces/screenshots/browser artifacts/OASIS (Sec. 0.3 item 8 + Sec. 3 + Sec. 9).

---

## 0. READ THIS FIRST - Autonomy Contract

### 0.1 What "autonomous" means here
You (Claude Code) will:
- Plan, write, test, commit, and deploy-to-dev across many sessions without asking approval for **normal engineering choices**.
- Resume by reading `CURRENT-STATE.md` (Sec. 11) at the start of every session and updating it at the end of every task.
- Make and document reasonable engineering decisions instead of pausing.
- Build against sandboxes, mocks, and fixtures wherever a real third-party credential, approval, or human identity step is required.

This autonomy applies to building software in a non-production environment. It does NOT extend to the categories in Sec. 0.2, 0.3, and 0.4.

### 0.2 Hard environment boundary - DEV/STAGING ONLY (never override)
The autonomous build operates exclusively in a dev/staging environment. You must NOT, under any circumstance, without explicit human approval recorded in `APPROVALS.md`:
- Deploy to, route traffic to, or modify any **production** Cloud Run service or revision.
- Run migrations against, read, write, or copy any **production** database or production data.
- Perform **destructive DB operations** (DROP, TRUNCATE, destructive ALTER, bulk DELETE) against any shared/persistent database, including dev, without a tested rollback (Sec. 0.7) and an explicit safe path.
- Make any **IAM change** (roles, bindings, service-account permissions, policy) in any environment.
- Provision or enable any **billing-impacting infrastructure** (new paid services, new databases beyond the dev instance, enabling costly APIs, raising quotas, GPU/large instances).
- Touch DNS, secrets values (you may add references/placeholders, never real secret material), or payment/financial rails.

Operating rules that follow from this:
- Stand up a dedicated dev environment: a dev Supabase project or branch, and `*-dev` Cloud Run services (e.g., `vcaop-api-dev`). Do NOT redeploy the production `vitana-gateway` service. For changes that must exercise the Gateway, deploy a tagged, no-traffic revision (`--no-traffic --tag vcaop-dev`) so production traffic is untouched.
- All third-party calls in CI are disabled; in dev they run only against sandboxes/mocks (Sec. 0.5).
- Production cutover, real credentials, prod IAM grants, and real KYB are runtime human tasks, out of scope for this build (Sec. 10).

### 0.3 Hard limits - never override (enforced as code + tests, Sec. 3)
1. **Never fabricate, guess, or hardcode third-party credentials.** Missing real secret -> blocker (Sec. 11.3), use a mock.
2. **Never auto-complete KYC/KYB, liveness, or video identity verification.** Route to the human-task queue.
3. **Never solve, bypass, or farm out CAPTCHAs.** CAPTCHA encountered -> pause job, create human task. No CAPTCHA-solving services, ever.
4. **Never store end-user loyalty/airline/hotel/retail login credentials**, or log into a user's loyalty account. User loyalty linking is consented, read-only, official-API-only.
5. **Never pool, transfer, resell, or broker loyalty points**, or build any account buy/sell/transfer "inventory marketplace." One canonical Exafy identity per provider; users own their own accounts.
6. **Never create multiple accounts per provider** for Exafy or mass-register accounts. Single canonical identity, reused.
7. **Never write secrets to the database, source, logs, or OASIS events.** Secrets live only in Secret Manager / vault; DB stores references and hashes.
8. **Never put PII into logs, LLM prompts/model context, traces, screenshots, browser artifacts, OASIS event payloads, or test fixtures.** PII is redacted at the boundary; browser-automation recordings/screenshots are scrubbed or not retained; tests use synthetic data only. (See Sec. 3 `no-pii-leak`, Sec. 9.)

A guardrail test may never be weakened to make a feature pass. If a feature cannot be built without violating a guardrail, abandon it, log it, continue.

### 0.4 Escalation - two tiers (replaces "zero interruptions")
**Tier A - decide and continue (no interruption):** normal engineering choices - library selection, schema tradeoffs, file layout, refactors, test design, mock shapes. Choose, log to `DECISIONS.md`, continue.

**Tier B - HALT and await human approval (write to `ESCALATIONS.md`, mark the task `AWAITING-APPROVAL`, move to the next independent non-Tier-B task):** you must stop and require explicit human sign-off for any decision that is:
- **Security** - auth model changes, exposure of an endpoint, anything weakening isolation, anything touching secrets handling beyond the defined vault pattern.
- **Privacy/legal** - new categories of PII/data collection, anything affecting the loyalty/affiliate legal posture, ToS interpretation that would loosen a per-provider policy, cross-border data handling.
- **Cost** - anything that would exceed the ceilings in Sec. 0.5, or provision billable infra.
- **Destructive infrastructure** - any production action (forbidden, Sec. 0.2), any destructive DB op, any IAM change, any DNS/billing change.

Do not invent a Tier-B action and then "approve it yourself." If genuinely blocked on a Tier-B item with no independent work left, stop and wait. For safety/legal ambiguity that is NOT clearly Tier B, choose the more restrictive option, log to `ESCALATIONS.md`, and continue.

### 0.5 Cost & resource controls (defaults below; treat as Tier-B to exceed)
- **Cloud Run (dev services):** `--max-instances=2`, `--concurrency=20`, `--timeout=300s`, modest `--memory` (<=512Mi) and `--cpu=1`. Never raise without approval.
- **Job/step timeouts:** single connector step <= 15 min; whole provisioning/commerce job <= 2 h; abort and mark `failed` on timeout.
- **External API call limits:** live third-party calls disabled in CI; in dev capped per provider per day (default 100) and behind a feature flag; browser connectors run only against local fixtures in CI.
- **LLM budget:** prefer the cheap WORKER model (Gemini Flash) for routine steps; reserve Claude (PLANNER/VALIDATOR) for planning/validation; cap per-session token spend and log usage. If a single task would blow the session budget, split it.
- **Spend ceiling / stop condition:** if estimated incremental GCP spend would exceed **$25/day** (dev), or any operation would provision billable infrastructure, or cumulative LLM spend would exceed the configured session budget -> HALT (Tier B), log to `ESCALATIONS.md`. Configure a billing budget alert reference in `DECISIONS.md` (do not create paid alerting infra without approval).

### 0.6 Branch, commit, and deploy permissions
- Work on a dedicated branch: `feature/vcaop` (create if absent). **Never push to `main`/`master`.** Open a PR; do not merge to a protected branch autonomously - merging to protected branches is Tier B.
- Commit every VTID with the VTID in the message. Frequent, small commits.
- Deploy ONLY to dev: `*-dev` Cloud Run services, or tagged no-traffic Gateway revisions (Sec. 0.2). Routing production traffic is Tier B.
- Never force-push, never rewrite shared history, never delete remote branches.

### 0.7 Rollback & recovery requirement
Every task that performs a migration or a deploy MUST define and record its rollback/recovery BEFORE executing:
- **Migrations:** provide a reversible Prisma migration (down path) or an explicit documented recovery; verify down-migration on the dev DB in the same task; never run a migration whose rollback is untested.
- **Deploys:** record the previous known-good revision; rollback = route/redeploy to it (dev only). For tagged no-traffic revisions, rollback is dropping the tag.
- **Destructive ops:** forbidden without approval (Sec. 0.2); if ever approved, require a verified backup/snapshot and a tested restore first.
- Record rollback steps in the task's `CURRENT-STATE.md` entry. A task without a recorded rollback for its migration/deploy is not `DONE`.

### 0.8 Dependency realism - verify before building
Named tools, SDKs, and protocols in this runbook (e.g., Google UCP / Shopify agent / Violet / Rye for checkout; Skyvern / Stagehand for browser; Skimlinks / Sovrn / Wildfire-class aggregators; provider APIs like SP-API/eBay/Walmart/CJ) may have changed, may be unavailable, may require approval, or may not fit. Before building any adapter:
1. Verify current official documentation and SDK/API availability and auth model.
2. If available and a fit: build behind the `Connector`/adapter interface so the specific vendor is swappable.
3. If unavailable, materially changed, or gated behind approval/cost: log to `BLOCKERS.md` with the finding, build a mock/sandbox adapter to the same interface, and continue. Do not hardcode to a vendor that you could not verify.
Record each verification (source + date + conclusion) in `DECISIONS.md`.

### 0.9 Definition of Done (whole initiative)
Done when: every VTID in Sec. 6 is `DONE` or `BLOCKED(external)` (logged) or `AWAITING-APPROVAL` (Tier B logged); all guardrail + unit/integration + IAM + privacy tests pass in CI; the platform deploys cleanly to the dev Cloud Run environment with recorded rollback; community and admin UIs are wired to the Gateway (dev); and the mock end-to-end "earn -> attribute -> credit-to-wallet" and "onboard mock supplier -> operate" loops pass. Production cutover and real provider/affiliate credentials/KYB remain runtime human tasks by design.

---

## 1. Context: existing stack and conventions

### 1.1 Repo and locations
- Monorepo: `exafyltd/vitana-platform`.
- Gateway: `services/gateway` (local `~/vitana-platform/services/gateway`), Express/TypeScript.
- OASIS: Supabase Postgres + Prisma. `OasisEvent` is the append-only single-source-of-truth ledger; relational tables are projections.
- Autopilot: `conductor`, `worker-core`, `validator-core`, `crewai-gcp` (merged via git subtree), `prompt-synth`. Role-based LLM routing: PLANNER -> Claude, WORKER -> Gemini Flash, VALIDATOR -> Claude.
- New initiative root: `services/vcaop/` (control plane API + connectors + commerce/rewards). Extend the existing OASIS Prisma schema in place; do NOT fork it.
- Frontend: extend the existing Vitanaland Next.js/React apps - community surfaces in the customer app, admin surfaces in the admin app. Detect existing structure and integrate; do not create a parallel app.

### 1.2 Deploy conventions (dev only; do not deviate)
- Deploy Cloud Run with `gcloud run deploy <service> --source . --region us-central1` from the service dir. **Never** `gcloud builds submit`.
- Apply the dev-only flags from Sec. 0.5 (`--max-instances=2`, etc.). Deploy `*-dev` services or tagged no-traffic Gateway revisions only (Sec. 0.2/0.6).
- TypeScript fetch typing fix: `const data = await resp.json() as any[]` (not `const data: any[] = await resp.json() as any`). Apply the known `sed` fix if `tsc`/`npm run build` errors.
- If GitHub Actions WIF deploy hits IAM `PERMISSION_DENIED`, log a blocker (Sec. 11.3) and fall back to dev `gcloud run deploy --source .`. Do not attempt IAM changes (Tier B / forbidden).

### 1.3 Secrets
- All secrets in Cloud Secret Manager by reference only; never inline. Dev/tests use `.env.example` placeholders and fixtures, never real values.

### 1.4 VTID tracking
- Use `LAYER-MODULE-NNNN`. Layers in Sec. 6. Every commit references its VTID; every build-progress OASIS event carries the VTID.

---

## 2. Architecture

VCAOP is the back-office control plane, governed by the `staff` role (human or AI), for two capabilities:
1. **Account onboarding & operations** - Exafy's OWN verified accounts across suppliers/marketplaces (supply side).
2. **Commerce & rewards** - community shops via a Universal Cart / Vitana assistant; capture affiliate commission; credit rewards to each user (demand side).

### 2.1 Three identity layers (different strategies)
- **L1 Supply (Exafy holds accounts):** API > OAuth > SCIM > browser > manual. KYB is human. Build fully.
- **L2 Affiliate (Exafy as publisher):** integrate ONE aggregator (verify per Sec. 0.8) to inherit ~50,000 merchants; reserve DIRECT publisher registration for top programs (Amazon Associates, Awin, CJ, Impact, Rakuten Advertising, Booking/Expedia) via the onboarding human-task flow. Vendor swappable behind an interface.
- **L3 Community rewards (user earns):** per-user SubID attribution -> Vitana rewards wallet. Loyalty miles only via official channels + consented read-only links (guardrails 4/5).

### 2.2 Control plane vs. agent runtime
- **Control plane** (VCAOP API on Gateway): source of truth for providers, jobs, accounts, affiliate programs, rewards ledger, policies, approvals. All state changes -> OASIS.
- **Agent runtime** (Autopilot): conductor plans; worker-core executes; validator-core verifies and gates sensitive actions to the human-task queue.

### 2.3 Connector precedence (onboarding AND checkout)
1. Native API -> 2. OAuth/app-install -> 3. SCIM/bulk (rare) -> 4. Browser fallback -> 5. Manual/human.
Checkout maps to: UCP / Shopify-agent / Violet (API-class) -> Rye/Skyvern (browser). One `Connector` interface (Sec. 4.4). Verify each per Sec. 0.8.

---

## 3. Guardrails as code (build FIRST)

Create `services/vcaop/src/guardrails/` with tested guardrails; CI fails if any guardrail test fails.
- `policy-engine.ts` - per-provider policy (Sec. 4.3); `assertActionAllowed(providerId, action)`; **default deny** for unknown providers/actions.
- `env-boundary.ts` - asserts the running environment is dev/staging; refuses (throws) on any prod target, destructive DB op, IAM call, or billing-impacting call (Sec. 0.2). Wraps deploy/migration helpers.
- `no-credential-store.ts` - DB-write guard + test failing if any `@sensitive`/credential/password/secret field is persisted in Postgres. User-loyalty models are schema-incapable of a password field.
- `no-pii-leak.ts` - redaction layer + tests asserting PII never appears in logs, LLM prompt payloads, traces, screenshots, browser artifacts, OASIS event payloads, or fixtures. Browser-artifact scrubber required.
- `human-gate.ts` - `HUMAN_REQUIRED` actions: `KYB`, `LIVENESS`, `CAPTCHA`, `PAYOUT_BANK_LINK`, `PRIVILEGE_ESCALATION`, `IRREVERSIBLE_SUBMIT`, `TRANSFER`. Connector hitting one MUST emit a `human_task` and halt the step; not bypassable.
- `no-captcha-solve.ts` - asserts no dependency on/call to any CAPTCHA-solving service; base class throws `CaptchaEncountered` -> task.
- `single-identity.ts` - at most one active `provider_account` per (tenant, provider) unless policy `multi_account_allowed=true` (default false).
- `no-account-market.ts` - no model/endpoint/UI implements account transfer/sale/inventory-pool semantics.
- `loyalty-guard.ts` - loyalty paths are read-only, credential-free; no pool/transfer/resale endpoint exists.
- `cost-guard.ts` - enforces Sec. 0.5 caps (call counts, timeouts, instance flags); throws/halts on breach -> Tier B.

**AC:** `npm run test:guardrails` green and a required CI gate before any deploy.

---

## 4. Data model (Prisma) and policy

Extend the OASIS/Prisma schema; reuse `OasisEvent`. Every mutating op appends an `OasisEvent` and updates read-models in the same transaction. No secrets/PII in event payloads.

### 4.1 Tenancy & identity
- `business_identity` - SINGLE canonical Exafy record: legal name, entity type, registration no., VAT/EORI, EIN, registered address, responsible officer (name + vaulted-ID reference), license refs, document refs (vault paths). Reused to populate every form/field.
- Reuse existing Vitanaland `tenant`/`user` if present; community users are `user` rows; Exafy back office runs under the platform tenant.

### 4.2 Onboarding (L1)
- `provider` - id, name, category, `connector_mode` (`api|oauth|scim|browser|manual`), `supports_bulk/mfa/rotation`, `jurisdiction`, `tos_risk_level`, `connector_config` (non-secret), `policy` (FK), `kyb_required`, `required_documents[]`.
- `provider_account` - `status` (`discovered|policy_approved|data_prepared|registration_submitted|kyb_pending|verification_pending|active|degraded|suspended|retired|failed`), `credential_ref`, `mfa_seed_ref`, `alias_mailbox`, `current_agent_id`.
- `provisioning_job`, `job_step`, `job_attempt`, `job_artifact` (artifacts scrubbed of PII/secrets).
- `human_task` - type (from `human-gate.ts`), assignee (named officer), payload (pre-filled, secret/PII-free where possible, else vault refs), status, SLA, evidence refs.
- `account_health_snapshot`.

### 4.3 Per-provider policy (gates every action)
`provider.policy` JSON (schema-validated):
```json
{
  "automation_allowed": "api_only | oauth_only | browser_with_human_submit | manual_only | denied",
  "registration_method": "human_required",
  "captcha_policy": "human_only",
  "kyb_required": true,
  "multi_account_allowed": false,
  "affiliate_cashback_allowed": null,
  "notes": "source ToS URL + date reviewed"
}
```
Unknown provider -> `"denied"` until a policy row exists. Major marketplaces -> `registration_method: human_required`, `captcha_policy: human_only`.

### 4.4 Connector interface
`services/vcaop/src/connectors/Connector.ts`:
```ts
export interface Connector {
  mode(): 'api'|'oauth'|'scim'|'browser'|'manual';
  // every method consults policy-engine + env-boundary; may throw HumanTaskRequired / CaptchaEncountered
  register(identity: BusinessIdentity, ctx: JobContext): Promise<RegisterResult>;
  verify(ctx: JobContext): Promise<VerifyResult>;
  operate(action: OperateAction, ctx: JobContext): Promise<OperateResult>;
  healthCheck(account: ProviderAccount): Promise<HealthResult>;
}
```
Adapters (mocks + sandbox per Sec. 0.8): `ApiConnector` (+ SP-API/eBay/Walmart/CJ stubs, post-registration), `OAuthConnector` (Shopify app-install, dropship suppliers), `BrowserConnector` (Skyvern primary, Stagehand cached flows; isolated profile per provider; artifacts scrubbed; every irreversible submit -> human gate; live runs disabled in CI), `ManualConnector` (human-task generator).

### 4.5 Secrets/vault (VAULT layer)
- `vault.ts` over Secret Manager (root) + per-provider store: `putCredential`, `getScopedShortLivedCredential(accountId, ttl)`, `putTotpSeed`, `generateTotp(accountId)` (RFC-6238, +/-1 step, in a trusted service, never the LLM), `putRecoveryCodes`. Short-lived scoped creds to worker-core at job time; never long-lived secrets to agents.
- OAuth lifecycle: proactive refresh; refresh-on-401 + backoff; refresh-token revocation -> `human_task` (re-auth magic link), account `degraded`.
- Email/OTP: alias-mailbox routing (`provider+<slug>@...`), deterministic inbox per onboarding; worker-core polls; never a human's personal inbox.

### 4.6 Commerce & rewards (L2/L3)
- `affiliate_program` - network, merchant, commission terms, `affiliate_cashback_allowed`, policy (same allow/deny discipline), source (`aggregator|direct`).
- `commission_event` - SubID, merchant, order ref, gross commission, status (`pending|confirmed|reversed`), postback ref.
- `rewards_ledger` - per-user accruals: `pending -> confirmed -> redeemable -> redeemed`, each transition an OasisEvent. Wallet balance is a projection.
- `user_reward_link` - consented, read-only loyalty links. **Schema-enforced: no password/secret field.** Stores program, user-provided member id (optional), consent record, official-API token ref (if any), `read_only=true`.
- `cart_order`, `merchant_route` - Universal Cart line items routed via checkout connector ladder (verify each per Sec. 0.8).
- `disclosure` - FTC-style affiliate disclosure, non-dismissible at checkout.

### 4.7 Audit
- `OasisEvent` carries every state change (onboarding step, commission, reward transition, approval). Immutable earnings + operations audit. No secrets/PII in payloads.

---

## 5. IAM / roles (community + admin + staff)

Integrate existing Vitanaland IAM. Roles: `community`, `admin`, `developer`, `staff` (human OR AI). Do NOT alter IAM bindings in any cloud environment (Tier B / forbidden); this is application-level RBAC + Supabase RLS only.
- **community**: own data only. Universal Cart, own `rewards_ledger`/wallet, own `user_reward_link` (read-only, consented). RLS `user_id = auth.uid()`. Never sees credentials/jobs/others' rewards.
- **staff**: runs the back office; creates/runs jobs, resolves assigned `human_task`s, operates accounts, runs commerce/monetization agents. Cannot bypass `human-gate`/`policy-engine`/`env-boundary`. AI-staff act under a scoped service identity per `agent_policy`.
- **admin**: sets per-provider/affiliate `policy`; approves sensitive `human_task`s (KYB/payout/transfer) and Tier-B items; views audit.
- **developer**: edits connectors/code, migrations, dev deploys. No production credentials or user PII beyond test needs.

Enforce at (1) Gateway authz middleware per endpoint (role + ownership) and (2) Supabase RLS per table. `iam.test.ts` asserts the role matrix: community cannot read another user's rewards; staff cannot satisfy a human gate alone; only admin changes policy; secrets unreadable by all roles via API.

---

## 6. Build plan - VTIDs, dependency order, acceptance criteria

Execute in order. Each VTID: build -> test (incl. `test:guardrails`) -> commit (VTID) -> emit OASIS event -> update `CURRENT-STATE.md` (with rollback notes for any migrate/deploy). Independent VTIDs may be reordered if blocked.

### Layer CTRL
- `CTRL-GUARD-0001` Guardrails (Sec. 3) incl. `env-boundary`, `no-pii-leak`, `cost-guard`. **AC:** `test:guardrails` green, CI-gated. *(first)*
- `CTRL-SCHEMA-0002` Prisma models 4.1-4.4, 4.6-4.7; reversible migrations (Sec. 0.7). **AC:** migrate up/down clean on fresh dev DB; OASIS append in same tx as read-model write.
- `CTRL-POLICY-0003` Policy engine + conservative seeds (top 20 providers, unknown=denied). **AC:** default-deny; unit tests per `automation_allowed`.
- `CTRL-API-0004` VCAOP REST API on Gateway: `/providers /accounts /jobs /tasks /affiliate-programs /rewards /cart /policies /approvals /audit`. **AC:** behind authz; OpenAPI generated; all writes emit OASIS events; no PII in logs.

### Layer IAM
- `IAM-ROLES-0001` Gateway authz + Supabase RLS for all VCAOP tables; role matrix. **AC:** `iam.test.ts` green; RLS verified per-role.

### Layer VAULT
- `VAULT-CORE-0001` Vault over Secret Manager; scoped short-lived issuance; TOTP; recovery codes. **AC:** no secret returned to community/developer API; RFC-6238 vectors pass; `no-credential-store` green.
- `VAULT-OTP-0002` Alias-mailbox + OTP polling (mockable). **AC:** simulated verification link resolves a job step.

### Layer CONN (verify each adapter per Sec. 0.8)
- `CONN-BASE-0001` `Connector` interface + base class enforcing policy/human-gate/CAPTCHA->task/env-boundary. **AC:** gates not bypassable.
- `CONN-API-0002` `ApiConnector` + provider stubs (post-registration) vs sandbox/mock. **AC:** mock round-trip for `operate`/`healthCheck`.
- `CONN-OAUTH-0003` `OAuthConnector` + token lifecycle + re-auth human task. **AC:** refresh + revocation->degraded tested.
- `CONN-BROWSER-0004` `BrowserConnector` (Skyvern primary, Stagehand cached); isolated profiles; artifact scrubbing; human submit gate; CI live-disabled. **AC:** dry-run vs local fixture; CAPTCHA fixture -> human task; no PII in artifacts.
- `CONN-MANUAL-0005` `ManualConnector`. **AC:** correctly pre-filled, secret/PII-free task payload from `business_identity`.

### Layer KYB
- `KYB-FLOW-0001` Human-in-the-loop onboarding: portal pre-fills; officer completes KYB/liveness/tax; artifacts vaulted and reused. **AC:** KYB provider advances only after staff+admin approval; artifacts reused on next provider.

### Layer AGNT
- `AGNT-CONDUCT-0001` Conductor plans jobs (connector tier + steps), PLANNER routing. **AC:** valid plan honoring policy.
- `AGNT-WORKER-0002` Worker-core executes (API/OAuth/browser/OTP/SubID), WORKER routing. **AC:** mock onboarding + mock cart route end-to-end.
- `AGNT-VALID-0003` Validator-core verifies + gates; rewards pending->confirmed only on confirmed postback, VALIDATOR routing. **AC:** rejects a step skipping a human gate; refuses unverified commission.
- `AGNT-MONET-0004` Monetization agent: at cart time resolve best route (aggregator vs direct), mint SubID link, record projected reward. **AC:** correct route per policy; never picks `affiliate_cashback_allowed=false` for cashback.

### Layer RWD
- `RWD-AGG-0001` Affiliate aggregator adapter (swappable; verify per Sec. 0.8), sandbox/mock keys. **AC:** link decoration + per-user SubID verified vs mock.
- `RWD-ATTR-0002` Postback ingestion -> `commission_event` -> `rewards_ledger` (pending/confirmed/reversed, clawbacks). **AC:** simulated postback credits correct user; reversal claws back.
- `RWD-DIRECT-0003` Direct publisher registration for top ~10 programs via KYB human-task path. **AC:** generates applications with site/app + tax/bank tasks; no auto-submit of identity.
- `RWD-LOYAL-0004` Consented read-only loyalty links (official APIs only) + routing to official program portals. **AC:** `loyalty-guard` green; no credential field; no pool/transfer/resale endpoint.

### Layer CMRC
- `CMRC-CART-0001` Universal Cart + `cart_order`/`merchant_route`; checkout ladder (UCP/Shopify-agent/Violet -> Rye/Skyvern), adapters + mocks (verify per Sec. 0.8). **AC:** multi-merchant cart builds/routes in mock; FTC disclosure non-dismissible.

### Layer UIC (community)
- `UIC-WALLET-0001` Wallet + earnings ledger (pending/confirmed/redeemable) + redemption. **AC:** reflects ledger; RLS blocks cross-user reads.
- `UIC-CART-0002` Universal Cart UI + assistant entry + affiliate disclosure + loyalty-link consent UI. **AC:** disclosure shown; consent stores read-only link only.

### Layer UIA (admin)
- `UIA-CATALOG-0001` Provider/affiliate catalog + policy editor + connector config (non-secret). **AC:** only admin edits policy; changes audited.
- `UIA-OPS-0002` Job queue, human-task inbox + approvals (KYB/payout/transfer + Tier-B), accounts lifecycle, audit/earnings explorer. **AC:** approvals advance jobs; full audit; no secrets/PII rendered.

### Layer OBS
- `OBS-KPI-0001` Metrics: onboarding success by connector, time-to-active, verification failure rate, cost/active account, commission confirmed vs reversed, reward payout latency, exception-queue age, cost-control counters. **AC:** dashboards read OASIS projections.

### Layer CICD
- `CICD-PIPE-0001` GitHub Actions: install -> lint -> typecheck -> `test:guardrails` (required) -> unit -> integration -> iam/privacy tests -> build -> deploy to **dev** via `gcloud run deploy --source .` (Sec. 0.5 flags), with recorded rollback. **AC:** pipeline green on `feature/vcaop`; guardrail gate blocks on failure; no push to protected branches; IAM-blocked WIF falls back to dev source deploy with a logged blocker.

---

## 7. Testing strategy (required gates)
- `test:guardrails` (Sec. 3) - mandatory pre-deploy gate; never weaken.
- `iam.test.ts` role matrix; RLS per-role connections.
- Privacy tests: assert no PII in logs/prompts/traces/artifacts/OASIS (Sec. 0.3 item 8).
- Unit + integration vs mocks/sandboxes only; no live third-party calls in CI; browser only vs local fixtures.
- Rollback verification: every migration task proves its down path on dev; every deploy task records the prior good revision.
- End-to-end mock: onboard mock supplier -> operate; shop mock merchant -> SubID attribute -> wallet credit -> confirm postback -> reversal. Both pass for DoD.

---

## 8. Deployment runbook (dev only)
1. Pre-deploy: record rollback (prior revision / down-migration), confirm `env-boundary` target is dev.
2. Migrations: apply reversible Prisma migrations to the dev Supabase DB; verify down path.
3. Deploy each service from its dir: `gcloud run deploy <service>-dev --source . --region us-central1 --max-instances=2 --timeout=300s`. Never `gcloud builds submit`. Never deploy/route production.
4. Gateway changes: tagged no-traffic revision (`--no-traffic --tag vcaop-dev`); never shift production traffic (Tier B).
5. Secrets: set references/placeholders only; real keys are blockers.
6. Smoke test dev vs the mock end-to-end flow.
7. Build fixes: fetch typing -> `const data = await resp.json() as any[]`; corrupted route -> `curl -o <path> https://raw.githubusercontent.com/exafyltd/vitana-platform/main/<path>`.
8. Rollback if smoke fails: redeploy prior good dev revision / drop the tag / run down-migration.

Production cutover, real credentials, prod IAM, KYB completion = runtime human tasks (Sec. 10).

---

## 9. Privacy & data handling (explicit)
- PII (officer identity, user identity, addresses, tax/bank data, member ids) is NEVER placed in: application/server logs, LLM prompts or any model context, tracing spans, browser-automation screenshots/recordings/DOM dumps, OASIS event payloads, or test fixtures.
- Redact at the boundary; pass vault references, not values. Browser artifacts are scrubbed or discarded immediately after use. Tests use synthetic PII only.
- Loyalty data: read-only, consented, official-API-only; no credentials stored (guardrail 4); no pooling/resale (guardrail 5).
- Any new PII category or new collection point is Tier B (Sec. 0.4).

---

## 10. Decisions baked in (do not revisit)
- Account buy/sell / inventory marketplace: CUT (guardrails 5/6). Single canonical identity only.
- Major-provider registration: human-gated by default; automation handles operations + long-tail form-fill only.
- CAPTCHA/liveness/KYB: human checkpoints, never automated.
- Affiliate scale via aggregator, not mass self-registration. Universal Cart over existing protocols (verify per Sec. 0.8), not from scratch.
- "Endless rewards" reframed in UI to "meaningful stacked savings on shopping you'd do anyway"; per-merchant `affiliate_cashback_allowed` gates cashback.

## 11. Execution protocol (the per-session loop)

### 11.1 State files (committed, repo `/vcaop/`)
- `CURRENT-STATE.md` - current VTID, % per layer, last/next action, env notes, rollback notes for the last migrate/deploy. Update after EVERY task.
- `BLOCKERS.md` - external dependencies (creds/approvals/IAM/unverified tools), the mock path taken, what a human must supply.
- `ESCALATIONS.md` - Tier-B items awaiting approval + safety/legal safe-default decisions, with rationale.
- `APPROVALS.md` - human approvals received (only a human edits this; you read it).
- `DECISIONS.md` - Tier-A engineering decisions + Sec. 0.8 dependency verifications (source + date + conclusion).

### 11.2 The loop
1. Session start: read `CURRENT-STATE.md`, `BLOCKERS.md`, `ESCALATIONS.md`, `APPROVALS.md`. Quick-pickup context (recent state + understanding; avoid full histories).
2. Select the next non-blocked, non-`AWAITING-APPROVAL` VTID in dependency order.
3. If the task contains a migrate/deploy: record rollback FIRST (Sec. 0.7).
4. Build it. Run its AC + `test:guardrails` + privacy/iam tests as relevant. Respect cost caps (Sec. 0.5).
5. Green: commit (VTID), emit OASIS event, update `CURRENT-STATE.md`.
6. Blocked by external dependency or unverified tool: log `BLOCKERS.md`, build the mock to the interface, mark `BLOCKED(external)`, continue.
7. Tier-B decision required (Sec. 0.4): log `ESCALATIONS.md`, mark `AWAITING-APPROVAL`, continue with the next independent non-Tier-B task. If none remain, STOP and wait.
8. Tier-A / non-Tier-B safety ambiguity: choose the more restrictive option, log, continue.
9. Repeat until DoD (Sec. 0.9).

### 11.3 Blocker rules
- Never fabricate a credential to unblock - mock, log, move on.
- Never weaken a guardrail to pass a feature - drop it, log it.
- Never perform a Tier-B action to unblock - escalate and continue elsewhere.
- Never let one blocked dependency stop the whole build - advance an independent VTID.

---

## 12. First action for Claude Code
Create `/vcaop/CURRENT-STATE.md`, `/vcaop/BLOCKERS.md`, `/vcaop/ESCALATIONS.md`, `/vcaop/APPROVALS.md`, `/vcaop/DECISIONS.md`; create branch `feature/vcaop`; confirm the dev environment target via `env-boundary`. Then begin `CTRL-GUARD-0001`. Build no feature before the guardrails package (incl. `env-boundary`, `no-pii-leak`, `cost-guard`) is green and CI-gated.
