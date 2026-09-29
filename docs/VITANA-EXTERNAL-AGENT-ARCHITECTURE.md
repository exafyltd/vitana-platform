# Vitana External Agent — Architecture, Connector Specs & Cost Model

**VTID-04743** · Draft for owner review · 2026-09-29 · Status: **proposal, nothing built by this doc**

Goal: turn Vitana + Autopilot into an autonomous preventive-health and
performance agent. It should act **inside Vitanaland and across third-party
apps** (wearables, labs, calendar, email, payments, providers) as a background
agent. It should plan in several steps, nudge proactively and keep working
after the user closes the app. It must scale from 10 connectors to
**hundreds or thousands** without a hand-written integration for each app.

This doc does three things: it picks the stack (§1), gives the code structure
(§2–§4), specifies the MVP connectors (§5) and prices it at scale (§7). Every
recommendation is checked against what already exists in this repo (§0), and
against the standing rules in `CLAUDE.md`.

---

## 0. What we already have (verified in code, 2026-09-29)

| Capability | Exists today | Gap for this project |
|---|---|---|
| Connector interface | `services/gateway/src/connectors/types.ts` (`Connector`: `getOAuthUrl`, `exchangeCode`, `refreshToken`, `fetchData`, `performAction`, `handleWebhook`), 10 connectors (oura, fitbit, strava, terra, vital, doctorbox, google, microsoft, apple, vitana_hub) | Registry is **static code imports**. `listConnectors()` ignores `connector_registry.enabled`. No manifest/codegen, so it doesn't scale past ~dozens |
| Action dispatch | `connectors/runtime/dispatcher.ts` (`dispatchAction`, refresh-on-use), `capabilities/index.ts` (`executeCapability`) | No rate limiter, circuit breaker or retry policy per provider |
| Token storage | `social_connections` (Google/MS) + `user_connections` (wearables); background refresher `oauth-token-refresher.ts` | **Two drifted stores, plaintext tokens** (open finding SEC-4). Refresher only covers `social_connections` |
| Webhooks | `routes/connector-webhooks.ts` → `connector_webhooks_log`, `wearable_daily_metrics`, `wearable_workouts` | Processed **inline** (no queue), no replay and no DLQ |
| Scheduled sync | none (nothing calls `fetchData`) | Needs a poller for providers without webhooks |
| Consent / approval | `services/consent-gate.ts` (`pending_connector_actions`, `action_ledger`, `user_action_permissions`), `data_sharing_consents` (+ events), `routes/consent-actions.ts` | Only one caller. Not wired into ORB tools or Autopilot |
| Action registry | `services/community-autopilot/action-registry.ts` (`ACTION_REGISTRY`, risk `low/medium`, `idempotencyKeyFor`) | Internal actions only |
| Run ledger | `agent_runs`, `agent_run_steps` (tokens, cost), `agent_run_signals` (`approval`, `user_reply`, `timeout`), `orchestrator/run-lease.ts` | Lease is flag-gated. No durable queue or timers |
| Policy | `orchestrator/tool-catalog.ts` (`read/draft/commit/high` tiers), `orchestrator/policy.ts`, `orchestrator/budgets.ts` | **Shadow-only**: nothing is enforced |
| LLM | `llm-router.ts` `callViaRouter(stage)`, Bedrock adapter, telemetry as OASIS `llm.call.*` events | Router has no tool-use loop. Stages need adding |
| Health data | `wearable_samples`, `biomarker_results`, `lab_reports`, `health_features_daily`, `vitana_index_scores`, `partner_health_test_orders`, `partner_health_results` | No time partitioning. No canonical coding (LOINC) enforced |
| Commerce | shopping agent proposes carts (`shopping-agent/agent-core.ts`, `applyUserLimitations()` checks allergies/meds). Checkout = affiliate redirect (decision D4). VCAOP (mock-only) has guardrails (`no-captcha-solve`, `human-gate`, `cost-guard`) | No agent-initiated payment. VCAOP not activated (BLK-006/009/010) |
| Memory | `memory_items`/`memory_facts` on pgvector, Titan v2 embeddings | Fine. Don't add Pinecone/Weaviate |
| Browser automation | none in production (Playwright only in dev `mcp-gateway`) | Needed only as a gated last resort |
| Mobile health | none. Apple Health needs a native companion (HealthKit is unreachable from the Appilix WebView) | Blocks Apple Health/Health Connect direct |

**Conclusion:** we are not starting from zero. About 60% of the runtime exists
as parts. The work is (a) **connect the parts** into one run engine, (b) **make
connectors data, not code**, and (c) **switch the shadow policy/budget layer
to enforce** for anything that touches the outside world.

---

## 1. Core stack: recommended path

The brief offered Option A (Llama/Groq + MedGemma, LangGraph, Cloud Run) and
Option B (fine-tuned Llama, custom state machine, per-user K8s pods). Neither
fits as given. Several pieces are forbidden by standing rules, and per-user VMs
are the wrong economics for a mostly event-driven workload. The recommended
path is **Option C: A's speed on B's control, on what we already run.**

| Layer | Recommendation | Why (and what we reject) |
|---|---|---|
| **Model** | **Claude on Bedrock, tiered by stage**: Haiku 4.5 for classify/extract/triage, Sonnet 5.5 for the agent loop and nudges, Opus 5.5 for long-horizon plan synthesis (rare). Routed via `llm_routing_policy` new stages `agent_triage`, `agent_worker`, `agent_planner`. | Rule 10a/10c: Claude via Bedrock, never direct Anthropic, never Google fallback. **MedGemma is a Google model**, and Groq/Together add a non-AWS PHI processor. Health reasoning quality comes from **grounding** (curated guideline corpus + PubMed citations + deterministic rules), not from fine-tuning. That is cheaper, auditable and updatable. **No fine-tuning in year 1.** |
| **Agent framework** | **Custom TS state machine on the existing run ledger** (`agent_runs`/`agent_run_steps`/`agent_run_signals`) + **SQS** work queues + **EventBridge Scheduler** for timers | We are TypeScript on ECS. LangGraph/CrewAI would duplicate the ledger, leases, OASIS events and policy we already have, and would hide state from OASIS (rule 1). Durable waits ("lab result arrives in 5 days") are rows + signals + a scheduled wake, not a process sleeping. Revisit Temporal/Step Functions only if run volume exceeds ~50 steps/s sustained. |
| **Execution** | **ECS Fargate worker pools** (not per-user pods) with **logical per-user isolation**: RLS, run-scoped short-lived credentials, per-user budget. **AgentCore Browser** only for the gated browser tier. | Per-user VMs (Muse-style) cost roughly 100× more for a workload that sits idle 99% of the time. Isolation that matters (data and credentials) is enforced at the credential and DB layer. Cloud Run is GCP (decommissioned). Lambda is not used for runs: its 15-minute cap and cold starts are bad for tool loops. Lambda is fine for webhook fan-in. |
| **Memory** | **Existing pgvector** (`memory_items`) + **Aurora Postgres** for structured health data. **Monthly-partitioned** `wearable_samples` + daily rollups. **S3/Parquet** for raw-payload archive. | Rule 21/26/27: memory_items and pgvector are canonical. No Pinecone/Weaviate (a new PHI processor for no gain). Aurora does not support TimescaleDB, so native partitioning (`pg_partman`) + rollups give the "temporal DB" behaviour. |
| **Connectors** | **Four-tier ladder** (T0 native API → T1 aggregator → T2 partner MCP → T3 gated browser), described by **declarative manifests**. Details in §3. | This is the only way to reach "thousands" without thousands of hand-written adapters. |

---

## 2. System architecture

```
                          ┌──────────────── Triggers ────────────────┐
  Member (app / ORB voice)│  user goal  │ webhook │ schedule │ signal │
                          └──────┬──────────┬─────────┬─────────┬────┘
                                 ▼          ▼         ▼         ▼
                         ┌────────────────────────────────────────────┐
                         │  gateway  (existing, ECS)                  │
                         │  /agent/goals  /connectors/webhook/:id     │
                         │  auth · tenant · RLS · consent API         │
                         └───────┬───────────────────┬────────────────┘
                                 │ enqueue           │ ingest (fast ack)
                   ┌─────────────▼──────┐   ┌────────▼──────────────┐
                   │ SQS agent-runs     │   │ SQS connector-ingest  │
                   │ (FIFO per user)    │   │ (std, DLQ)            │
                   └─────────┬──────────┘   └────────┬──────────────┘
                             ▼                       ▼
     ┌────────────────────────────────┐   ┌──────────────────────────────┐
     │ agent-runtime workers (NEW ECS)│   │ connector-sync workers (NEW) │
     │  RunEngine ─ Planner (Opus)    │   │  normalize → canonical health│
     │           ─ StepExecutor(Son.) │   │  schema (LOINC/UCUM)         │
     │           ─ PolicyGate ◄───────┼───┤  → signal detectors (rules)  │
     │           ─ BudgetGuard        │   │  → emit agent signal         │
     └───┬───────────┬────────────────┘   └───────────┬──────────────────┘
         │ tools     │ approval needed                │
         ▼           ▼                                ▼
  ┌──────────────┐ ┌───────────────────────┐   ┌─────────────────────────┐
  │ Connector    │ │ consent-gate (exists) │   │ Aurora: wearable_samples│
  │ Gateway (NEW)│ │ push / ORB readback   │   │ (partitioned), rollups, │
  │ T0 native    │ │ → agent_run_signals   │   │ biomarker_results,      │
  │ T1 aggregator│ └───────────────────────┘   │ agent_runs, memory_items│
  │ T2 MCP       │                             └─────────────────────────┘
  │ T3 browser ──┼──► AgentCore Browser (gated, human-in-loop)
  │ rate-limit · │
  │ breaker ·    │──► Credential Vault (KMS envelope, NEW; replaces
  │ idempotency  │     social_connections/user_connections token cols)
  └──────────────┘
  EventBridge Scheduler: per-run timers ("check lab status in 48h"),
  per-user cadences (morning signal scan), token refresh sweeps.
  Every state transition → emitOasisEvent (OASIS SSOT).
```

**Principles**

1. **Rules first, LLM second.** Signal detection (HRV drop, sleep debt, checkup
   overdue) is deterministic SQL/TS over rollups. The LLM runs only when a
   rule fires or a user asks. This single decision makes up most of the cost
   model (§7).
2. **Plans are data.** A plan is a DAG of typed steps stored in
   `agent_run_steps`, so it can be paused, resumed, approved, replayed and
   audited, and it survives deploys.
3. **Every external side-effect passes one gate.** `PolicyGate` decides
   `auto | confirm | two_person | deny`. Nothing calls a connector's write
   path any other way.
4. **Idempotent everything.** Each step carries an `idempotency_key`
   (`idempotencyKeyFor` pattern). Retries never double-book or double-charge.

---

## 3. Connector layer — built for thousands

### 3.1 The tier ladder

| Tier | What | When | Examples | Build cost per connector |
|---|---|---|---|---|
| **T0 Native** | Our own adapter on the provider's REST/OAuth API, declared by manifest | Top ~20 apps by user demand, anything with writes or money | Oura, Whoop, Withings, Google Calendar, Microsoft Graph, Stripe, DoctorBox | 2–5 dev-days (manifest + normalizer + contract tests) |
| **T1 Aggregator** | One integration that fans out to hundreds of devices | Long tail of wearables/devices, read-only | Terra (existing connector), Vital/Junction (existing), Spike | ~0 per device once the aggregator is wired |
| **T2 Partner MCP** | Partner exposes an MCP server; we connect as an MCP client with OAuth 2.1 | Services that publish agent-ready tools (booking, pharmacy, labs, retail) | Growing set; our own `vcaop-mcp` proves the pattern | ~0.5 day: manifest + scope mapping + policy tiering |
| **T3 Browser** | Headless browser driven by a computer-use loop in AgentCore Browser | No API and no MCP, **user-initiated only**, low frequency | Booking a slot on a clinic site without an API | Per-site recipe + mandatory human gate. Never unattended writes |

The ladder is also the **routing order at runtime**. For a capability such as
`appointment.book`, the Connector Gateway picks the highest tier available to
this user and provider. T3 is used only if T0–T2 can't serve it and the user
has approved browser actions for that site.

**Hard rules for T3** (from VCAOP guardrails, which carry over unchanged): no
CAPTCHA solving, no credential storage in the browser (session cookies are
injected per run from the vault and discarded), single identity, no account
creation on the user's behalf, a human gate before any submit that books,
buys or sends.

### 3.2 Connector Manifest v2 (declarative)

Connectors become **data**: one `manifest.yaml` + an optional `adapter.ts` for
the parts that can't be declared. The build validates the manifests and
generates (a) `connector_registry` seed rows, (b) the agent tool definitions,
(c) contract-test stubs. This is how we go from 10 to 1,000 without 1,000 PRs
into `index.ts`.

```yaml
# connectors/oura/manifest.yaml
id: oura
version: 2
category: wearable
tier: T0
display_name: { key: connectors.oura.name }        # i18n key, never raw text
auth:
  type: oauth2
  authorize_url: https://cloud.ouraring.com/oauth/authorize
  token_url: https://api.ouraring.com/oauth/token
  pkce: false
  scopes: [daily, heartrate, workout, session, personal]
  client_id_secret: OURA_CLIENT_ID            # env / Secrets Manager name only
  refresh: rotating                            # rotating | static | none
data_residency: [eu, us]                       # where the provider stores data
phi: true                                      # triggers Art. 9 consent flow
rate_limits:
  - scope: app,   limit: 5000, window: 300s
  - scope: token, limit: 5000, window: 300s    # provider-reported, see §5
sync:
  mode: webhook_first                          # webhook_first | poll | push_sdk
  webhook:
    verify: hmac_sha256
    secret: OURA_WEBHOOK_SECRET
    subscriptions: [daily_sleep, daily_readiness, workout]
  poll_fallback: { every: 6h, backfill_days: 30 }
streams:
  - id: sleep
    endpoint: GET /v2/usercollection/daily_sleep
    cursor: { param: start_date, type: date }
    maps_to: canonical.sleep_session           # normalizer in adapter.ts
  - id: hrv
    endpoint: GET /v2/usercollection/sleep
    maps_to: canonical.hrv_rmssd
capabilities:
  - id: sleep.read
    kind: read
    risk: read
  # Oura has no write API, so this connector declares no write capabilities
health:
  breaker: { error_rate: 0.5, window: 60s, cooldown: 300s }
  retry: { max: 5, backoff: exponential, jitter: true, on: [429, 5xx] }
```

For a write-capable connector the capability block carries the policy
metadata the agent needs:

```yaml
capabilities:
  - id: calendar.event.create
    kind: write
    risk: commit            # read | draft | commit | high  (tool-catalog tiers)
    reversible: true
    compensate: calendar.event.delete
    confirm: first_time     # always | first_time | never(auto within grant)
  - id: payment.charge
    kind: write
    risk: high
    reversible: false
    confirm: always
    spend_cap_required: true
```

### 3.3 Connector SDK v2 (TypeScript)

This extends, not replaces, `connectors/types.ts`. Existing connectors keep
working through a v1→v2 shim.

```ts
// packages/connector-sdk/src/types.ts
export type RiskTier = 'read' | 'draft' | 'commit' | 'high';

export interface CapabilitySpec {
  id: string;                       // 'calendar.event.create'
  kind: 'read' | 'write';
  risk: RiskTier;
  reversible: boolean;
  compensate?: string;              // capability id that undoes this one
  confirm: 'always' | 'first_time' | 'never';
  spendCapRequired?: boolean;
  inputSchema: JSONSchema7;         // becomes the Claude tool input_schema
  outputSchema?: JSONSchema7;
}

export interface ConnectorManifestV2 {
  id: string;
  version: 2;
  tier: 'T0' | 'T1' | 'T2' | 'T3';
  category: ConnectorCategory;      // existing enum + 'booking' | 'pharmacy' | 'payments'
  auth: AuthSpec;                   // oauth2 | api_key | mcp_oauth21 | sdk_bridge | browser_session
  phi: boolean;
  dataResidency: ('eu' | 'us' | 'uk')[];
  rateLimits: RateLimitSpec[];
  sync: SyncSpec;
  streams: StreamSpec[];
  capabilities: CapabilitySpec[];
  health: { breaker: BreakerSpec; retry: RetrySpec };
}

/** Only the parts a manifest can't express. All optional. */
export interface ConnectorAdapter {
  normalize?(stream: string, raw: unknown, ctx: NormalizeCtx): CanonicalRecord[];
  verifyWebhook?(req: RawRequest): boolean;
  parseWebhook?(req: RawRequest): WebhookEnvelope[];
  perform?(cap: string, args: unknown, ctx: ActionCtx): Promise<ActionResult>;
}

export interface ActionCtx {
  tenantId: string;
  userId: string;
  runId: string;
  stepId: string;
  idempotencyKey: string;           // required on every write
  credentials: ScopedCredential;    // short-lived, from vault, never persisted by adapter
  http: GovernedHttpClient;         // rate-limit + breaker + retry + telemetry baked in
}

export function defineConnector(m: ConnectorManifestV2, a: ConnectorAdapter = {}) {
  return { manifest: validateManifest(m), adapter: a };
}
```

`GovernedHttpClient` is the one place where rate limits (Redis token bucket
keyed by `connector:app` and `connector:token:<hash>`), circuit breakers,
retries with jitter, and the OASIS `connector.call.*` telemetry live. Adapters
cannot open raw sockets. A lint rule bans `fetch` in `connectors/**`.

### 3.4 Canonical health schema

Every stream normalizes into one shape, so the agent reasons over "HRV", not
"Oura HRV vs Whoop HRV":

```ts
interface CanonicalRecord {
  userId: string;
  metric: CanonicalMetric;          // 'hrv_rmssd' | 'resting_hr' | 'sleep_duration' | 'vo2max' | 'steps' | ...
  loinc?: string;                   // e.g. 80404-7 (HRV), 8867-4 (heart rate); required for lab biomarkers
  value: number;
  unit: string;                     // UCUM ('ms', '/min', 'mL/kg/min')
  start: string; end?: string;      // ISO-8601, UTC
  source: { connector: string; device?: string; tier: 'T0'|'T1'|'T2' };
  quality: 'measured' | 'estimated' | 'self_reported';
  provenanceId: string;             // → raw payload in S3 for audit
}
```

This lands in the existing `wearable_samples` / `biomarker_results` (with
`metric`, `loinc`, `unit`, `quality` columns added) and rolls up into
`health_features_daily`. Aligning with FHIR `Observation` (LOINC + UCUM) keeps
the SMART-on-FHIR path (`services/smart-fhir-oauth.ts`) open for clinical data.

### 3.5 Credential Vault (fixes SEC-4)

- One table, `connector_credentials`, replacing the token columns of
  `social_connections` and `user_connections`, with a migration and dual-read
  period.
- **KMS envelope encryption.** A per-tenant CMK wraps per-connection data
  keys. The existing AES-256-GCM helper (`lib/ai-credential-crypto.ts`) is the
  pattern.
- Workers never read the table. They call `vault.issue(runId, connector,
  scopes)` and get a scoped credential that lives for the run, which the
  adapter uses and discards.
- One refresher for all connectors: it extends `oauth-token-refresher.ts`,
  driven by EventBridge, and emits `oauth.token.refresh.failed` → user
  re-connect nudge.

### 3.6 Tool exposure at scale

The agent can't see 1,000 tools per turn. The approach:

1. **Per-user filter**: only capabilities of connectors the user has
   connected, and that the user's grants allow (typically 10–40).
2. **Capability-level tools, not provider-level.** The model sees
   `calendar_create_event`, and the Connector Gateway resolves Google vs
   Outlook from the user's default provider (existing
   `set_capability_preference`). This keeps the tool list independent of how
   many providers exist.
3. **Retrieval for the rest.** If a plan needs a capability that is not
   loaded, one `find_capability(query)` tool searches the capability index
   (Titan embeddings over manifest descriptions) and loads it. If the
   Bedrock deployment supports Claude's server-side tool search with
   `defer_loading`, use that instead. **Verify availability on our Bedrock
   region before relying on it.**

---

## 4. Agent runtime — code structure

A new ECS service, `services/agent-runtime/`, shares packages with the
gateway. The gateway keeps the HTTP surface. The runtime owns execution.

```
services/agent-runtime/
├── src/
│   ├── main.ts                       # SQS consumers + /alive on 8080
│   ├── engine/
│   │   ├── run-engine.ts             # state machine: planned→running→waiting→done|failed|cancelled
│   │   ├── planner.ts                # goal → PlanDAG  (stage: agent_planner / Opus 5.5)
│   │   ├── step-executor.ts          # one tool loop per step (stage: agent_worker / Sonnet 5.5)
│   │   ├── replanner.ts              # on failure / new signal: patch remaining DAG
│   │   ├── signals.ts                # agent_run_signals: approval, user_reply, webhook, timeout
│   │   ├── timers.ts                 # EventBridge Scheduler one-shots per waiting step
│   │   └── lease.ts                  # re-export orchestrator/run-lease (enforced, not flag-gated)
│   ├── policy/
│   │   ├── policy-gate.ts            # auto | confirm | two_person | deny  (enforces tool-catalog tiers)
│   │   ├── consent.ts                # wraps services/consent-gate.ts + data_sharing_consents (Art. 9)
│   │   ├── spend-guard.ts            # per-user monthly cap, per-action cap, Stripe mandate check
│   │   ├── medical-guard.ts          # red-flag symptom → stop + "see a clinician"; no dx/rx language
│   │   └── budget-guard.ts           # LLM $ per user / per run (agent_runs.budget_usd, enforced)
│   ├── tools/
│   │   ├── tool-registry.ts          # manifests → Claude tool defs (per-user filtered)
│   │   ├── internal-tools.ts         # Vitanaland actions: ACTION_REGISTRY bridge
│   │   └── find-capability.ts        # retrieval over capability index
│   ├── playbooks/                    # declarative goal templates, planner fills the gaps
│   │   ├── sleep-optimization.yaml
│   │   ├── annual-checkup.yaml
│   │   ├── vo2max-block.yaml
│   │   └── blood-panel.yaml
│   ├── signals/                      # deterministic detectors (no LLM)
│   │   ├── hrv-drop.ts               # 7d HRV vs 28d baseline, z-score
│   │   ├── sleep-debt.ts
│   │   ├── checkup-overdue.ts
│   │   ├── lab-result-arrived.ts
│   │   └── training-load.ts          # acute:chronic workload ratio
│   ├── grounding/
│   │   ├── guideline-corpus/         # curated, versioned, cited (USPSTF/ESC/WHO etc.)
│   │   └── retrieve.ts               # pgvector retrieval with citations attached to outputs
│   └── telemetry/oasis.ts            # emitOasisEvent wrappers: agent.run.*, agent.step.*
└── test/
    ├── run-engine.regression.test.ts # in-memory DB + fake connectors (mirrors VTID-04465 style)
    ├── policy-gate.test.ts
    └── playbooks/*.golden.test.ts

packages/connector-sdk/               # §3.3 (shared by gateway + runtime + sync workers)
connectors/<id>/manifest.yaml (+ adapter.ts)
services/connector-sync/              # ingest queue consumers, pollers, normalizers
```

### 4.1 Data model additions

```sql
-- plans are steps in the existing ledger; add structure, don't add a new ledger
alter table agent_run_steps
  add column depends_on uuid[] default '{}',
  add column capability text,               -- 'calendar.event.create'
  add column risk text,                     -- read|draft|commit|high
  add column policy_decision text,          -- auto|confirm|two_person|deny
  add column idempotency_key text unique,
  add column compensation_step_id uuid,
  add column wake_at timestamptz;           -- durable wait

create table agent_goals (                  -- long-lived user objectives ("best shape of my life")
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, user_id uuid not null,
  playbook text, title_key text, params jsonb,
  cadence text,                             -- e.g. weekly review
  status text check (status in ('active','paused','done','abandoned')),
  created_at timestamptz default now()
);  -- RLS: tenant_id + user_id, like every other table

create table agent_grants (                 -- standing permissions; extends user_action_permissions
  user_id uuid, capability text, connector text,
  max_per_action_cents int, max_per_month_cents int,
  confirm_mode text, expires_at timestamptz,
  primary key (user_id, capability, connector)
);

create table connector_credentials ( ... ); -- §3.5, KMS-wrapped
-- wearable_samples → partitioned by month (pg_partman), + metric/loinc/unit/quality
```

`DATABASE_SCHEMA.md` gets updated in the same PR as each migration (rule 24).

### 4.2 Run engine: the core loop (illustrative)

```ts
// services/agent-runtime/src/engine/run-engine.ts  (illustrative)
export async function advanceRun(runId: string): Promise<void> {
  await withLease(runId, async (run) => {
    const ready = await steps.readyToExecute(runId);   // deps satisfied, not waiting
    for (const step of ready) {
      const decision = await policyGate.evaluate(run, step);
      await steps.recordDecision(step.id, decision);

      switch (decision.kind) {
        case 'deny':
          await replanner.onBlocked(run, step, decision.reason);
          continue;
        case 'confirm':
        case 'two_person':
          await consent.requestApproval(run, step, decision); // push / ORB readback / in-app card
          await steps.markWaiting(step.id, { signal: 'approval', timeoutH: 48 });
          continue;
        case 'auto':
          break;
      }

      if (!(await budgetGuard.allow(run, step))) {
        await steps.markWaiting(step.id, { signal: 'budget', timeoutH: 24 });
        continue;
      }

      const result = await stepExecutor.execute(run, step); // Claude tool loop via callViaRouter
      await steps.complete(step.id, result);
      await oasis.emit('agent.step.completed', run, step, result.summary);

      if (result.wait) await timers.schedule(step.id, result.wait.at); // e.g. poll lab status in 48h
    }
    await run.finalizeIfDone();
  });
}
```

The step executor is a **bounded** tool loop: at most N tool calls per step
and a per-step token budget. It goes through `callViaRouter('agent_worker', …)`
so provider choice, fallback and telemetry stay governed (rules 33/35/39).
The router needs a tool-use extension (tools in, `tool_use` blocks out).
Today it is text-only. Every user-facing text the agent produces is composed
in the user's locale (`services/gateway/src/i18n/llm-locale.ts`). Spoken lines
are **intent-prompted, never hardcoded** (rule 41).

### 4.3 Policy matrix (what runs without asking)

| Risk | Examples | Default | With standing grant |
|---|---|---|---|
| `read` | Pull Oura sleep, read calendar free/busy | auto (after connect consent) | auto |
| `draft` | Draft 12-week plan, draft email, build cart | auto, shown to user | auto |
| `commit` (reversible, no money) | Create calendar event, set reminder, send nudge from Vitana's own sender | **confirm first time**, then auto | auto, with a daily digest of what it did |
| `high` (money, PHI sharing, irreversible, bookings with fees) | Order blood test, buy supplements, share results with a clinic, book paid slot | **always confirm**, with read-back on voice | confirm still required. The grant only pre-authorizes the **spend cap** |
| Medical red flags | Chest pain, suicidal ideation, abnormal critical lab value | **agent stops**, escalates to "contact a clinician / emergency", no automation | n/a |

This matches the owner-approved community-autopilot policy: voice may commit
only low-risk actions on the member's own data, and medium risk needs read-back.
`high` actions are approved in the app, with a biometric/PIN step for payments.

---

## 5. MVP connector specs (weeks 1–2)

| # | Connector | Tier | Auth | Data / actions | Sync | Limits & gotchas | Status in repo |
|---|---|---|---|---|---|---|---|
| 1 | **Oura** | T0 | OAuth2 | read: sleep, readiness, HRV, activity, workouts | webhook-first, 6h poll fallback | 5,000 req / 5 min (per-token and per-app layers). Webhooks strongly recommended. No write API | connector exists (`fetchData`). Add manifest v2 + webhook subscriptions |
| 2 | **Whoop** | T0 | OAuth2 | read: recovery, strain, sleep, HRV, workouts | webhooks (v2) + poll | **100 req/min, 10,000 req/day per client** by default. At scale we must request an increase from WHOOP up front, and webhooks are mandatory | **new** |
| 3 | **Apple Health** | T1 now / native later | on-device HealthKit | read: HR, HRV, sleep, VO2max, workouts, steps | device push (background delivery) | **No server API.** HealthKit is unreachable from our WebView, so either Terra/Vital mobile SDK in a thin native companion, or our own Swift companion (`requires_ios_companion` already modeled) | Terra/Vital connectors exist; companion app **does not** |
| 4 | **Android: Health Connect** (+ Fitbit via Google Health API) | T1 / T0 | on-device / OAuth2 | same as above | device push / poll | **Google Fit APIs are deprecated, supported only until end of 2026, and closed to new sign-ups since May 2024.** Do not build on Fit. Health Connect is on-device (same companion need). Fitbit cloud moves to the Google Health API. Our `fitbit` connector must migrate. (This is a user-data connector, not the forbidden Google LLM/infra dependency.) | fitbit connector exists (partly stubbed) |
| 5 | **Long-tail wearables** (Garmin, Polar, Withings, Coros, Eight Sleep, CGMs …) | T1 | via Terra / Vital | read-only | aggregator webhook (HMAC) | Terra: usage-based, ~200 credits per active user per month (see §7) | exist (`terra.ts`, `vital.ts`) |
| 6 | **Labs: DoctorBox** (EU, partner #001) | T0 | partner (webhook_only today) | order panel, receive results, status | webhook | Needs order API, not just results webhook. Consent via `data_sharing_consents` | exists (results), **order path new** |
| 7 | **Labs: next partner(s)** (e.g. Thriva white-label API for UK. Per-country EU partners) | T0 / T2 | partner API key / MCP | order kit, schedule phlebotomy, results (→ LOINC) | webhook | B2B contracts per country. Results are Art. 9 data | new. Choose by launch country |
| 8 | **Google Calendar** | T0 | OAuth2 (`calendar.events`: sensitive scope) | read free/busy, create/update/delete events | push channels + sync token | Google OAuth verification needed. **Neither Google nor Microsoft OAuth client is configured on staging/prod yet** (blocker) | exists (`google` connector, `calendar-google-sync.ts`) |
| 9 | **Outlook / Microsoft 365** | T0 | OAuth2 (Graph) | calendar + mail | Graph change notifications | rotating refresh tokens (already handled) | exists |
| 10 | **Email (nudges, reports, confirmations)** | internal | — | send from Vitana's own domain (SES) | — | **Recommendation: do NOT use `gmail.send` for MVP.** Gmail send is a *restricted* scope requiring a yearly CASA security assessment. Nudges and reports from `noreply@vitanaland` need no user scope. Read-only mail (`read_email`) only where users explicitly want it | `google` connector has Gmail. SES path to confirm |
| 11 | **Stripe** | T0 | platform keys + Connect | charge for Vitana-sold services, SetupIntent for agent spend mandate, Connect payouts to partners | webhooks (signature-verified) | EU SCA: the first payment is on-session. Later agent-initiated charges are merchant-initiated **off-session** under a stored mandate, within `agent_grants` caps. Decision D4 says affiliate products are redirect-only (Vitana doesn't take payment), so the agent **builds the cart and hands off** for affiliate items | wallet/Connect webhooks exist. Agent spend path **new** |
| 12 | **Provider booking** (GPs, clinics, trainers) | T2 / T3 | partner / browser | find slot, book, cancel | — | Few public booking APIs (the big EU platforms are partner-only). MVP: partners via T2, otherwise **prefilled hand-off link** and, later, gated T3 | new |

---

## 6. Workflows as playbooks (weeks 2–4)

Playbooks are declarative. The planner fills user-specific gaps, and policy
applies per step. Example:

```yaml
# playbooks/sleep-optimization.yaml
id: sleep-optimization
title_key: agent.playbooks.sleep.title
requires: { any_of: [capability: sleep.read] }
steps:
  - id: analyze
    tool: health.analyze_trend            # internal, deterministic stats + LLM summary
    args: { metrics: [sleep_duration, sleep_efficiency, hrv_rmssd, resting_hr], window_days: 28 }
  - id: screen
    tool: medical.screen_red_flags        # e.g. snoring+daytime sleepiness → suggest clinician, stop automation
    depends_on: [analyze]
  - id: plan
    tool: plan.draft_sleep_protocol       # grounded in guideline corpus, citations attached
    depends_on: [screen]
  - id: reminders
    capability: reminder.create           # risk: commit → confirm first time
    depends_on: [plan]
  - id: calendar_winddown
    capability: calendar.event.create     # recurring wind-down block
    depends_on: [plan]
  - id: supplements
    capability: cart.propose              # draft only; applyUserLimitations() (meds/allergies) enforced
    optional: true
    depends_on: [plan]
  - id: review
    wait: { days: 14 }
    then: replan                          # compare 14d vs baseline, adjust
```

| Workflow | Key steps | External connectors | Highest risk step |
|---|---|---|---|
| **Optimize my sleep** | trend analysis → red-flag screen (sleep-apnea signals → clinician, **not** an automated sleep-study booking) → protocol → reminders → optional cart | Oura/Whoop/HealthKit, Calendar, cart | `cart.propose` (draft). Purchase is a hand-off or `high` |
| **Annual checkup** | last-visit lookup → find provider → propose slots → book → calendar → prep email | Calendar, booking partner, SES | `appointment.book` (`high` if fee/no-show charge) |
| **Improve VO2max** | training-load analysis (ACWR) → zone-2 prescription → schedule sessions → weekly check-in | Wearables, Calendar | `calendar.event.create` (commit) |
| **Order blood test** | recommend panel by age/sex/goals (rule table + guideline citations) → **user approves** → order → phlebotomy slot → wait for webhook → LOINC-normalize → explain results → flag abnormal to clinician | Lab partner, Stripe/partner checkout, Calendar | `lab.order` (`high`, money + PHI) |
| **Proactive: HRV drop** | detector fires (z < −1.5 for 3 days) → check calendar for HIIT → propose swap to zone 2 → nudge | Wearables, Calendar, push | nudge (auto). Calendar edit (commit) |

---

## 7. Cost breakdown at scale

### 7.1 Price inputs (2026-09-29; verify against AWS invoices before budgeting)

| Item | Unit price | Source / note |
|---|---|---|
| Claude Haiku 4.5 | $1 / $5 per M tokens in/out | Anthropic list price. Bedrock on-demand is typically at parity; regional (EU) endpoints may carry a premium. **Verify on our Bedrock console** |
| Claude Sonnet 5.5 | $2 / $10 per M; cache read $0.20 | cheaper than our current default Sonnet 4.6 ($3/$15) |
| Claude Opus 5.5 | $4 / $20 per M; cache read $0.20 | planner only |
| Prompt cache write | ~1.25× input price | cache reads ~0.1× |
| Batch inference | −50% | weekly reports, backfills |
| Titan Embeddings v2 | ~$0.02 per M tokens | already in use |
| AgentCore Browser | $0.0895 per vCPU-hour + $0.00945 per GB-hour (active only) | T3 only |
| Terra (aggregator) | from $399/mo (annual) incl. 100k credits; ~200 credits per active user per month; overage $0.005/credit, $0.003 above 1M | T1 long tail |
| Fargate (eu-central-1) | ~ $0.048 per vCPU-hour, ~ $0.0053 per GB-hour | approximate, check calculator |
| SQS / EventBridge Scheduler | $0.40 per M requests / $1 per M invocations | negligible at our scale |
| SES | $0.10 per 1,000 emails | |
| Stripe (EEA cards) | ~1.5% + €0.25 per charge | pass-through, not platform cost |

### 7.2 LLM cost per active user per month (the dominant variable)

Assumptions: rules-first detection, 70–75% prompt-cache hit on the stable
system/tool prefix, locale-aware outputs.

| Workload | Model | Volume per user per month | Tokens per call (in / out) | $ per user per month |
|---|---|---|---|---|
| Signal triage (rule fired → is it worth a nudge?) | Haiku 4.5 | 30 | 3k / 0.3k | 0.14 |
| Proactive nudge composition | Sonnet 5.5 | 20 | 8k (6k cached) / 0.4k | 0.18 |
| User-initiated agent runs (~6 steps each) | Sonnet 5.5 | 15 runs = 90 steps | 12k (70% cached) / 0.8k | 1.52 |
| Plan synthesis / replan (12-week plans) | Opus 5.5 | 1 | 40k / 6k | 0.28 |
| Weekly report | Sonnet 5.5, **batch** | 4 | 20k / 1.5k | 0.11 |
| Embeddings (memory + capability retrieval) | Titan v2 | ~200k tokens | — | <0.01 |
| **Standard active user** | | | | **≈ $2.25** |

Usage profiles:

| Profile | Behavior | LLM $ per month |
|---|---|---|
| Passive (connected, nudges + weekly report only) | no user-initiated runs | ≈ $0.45 |
| Standard | as above | ≈ $2.25 |
| Power (daily coaching, ~2 runs/day) | ~60 runs, more replanning | ≈ $7.50 |
| **Blended** (50% passive / 40% standard / 10% power) | | **≈ $1.90** |

With the rules-first design removed, i.e. a Sonnet pass over every incoming
webhook sync (~4/day) for every user, triage alone rises to ~$1–3 per user per month. That
is why detectors are deterministic.

### 7.3 Full unit cost per active user per month (blended)

| Component | $ / MAU / month | Note |
|---|---|---|
| LLM (Bedrock) | 1.90 | §7.2 blended. Add ~10% if EU regional pricing applies |
| Wearable aggregator (T1) | 0.30–0.40 | Terra ≈ $0.60–1.00 per aggregated user, × ~40% of users not covered by free native APIs (Oura/Whoop/Withings T0) |
| Browser tier (T3) | 0.05 | ~$0.40–0.60 per browser task (LLM computer-use steps dominate, browser compute ≈ $0.005), 10% of users × 1 task per month |
| Compute (Fargate: runtime + sync workers) | 0.02–0.04 | ~20 tasks at 100k MAU |
| Aurora (storage + I/O + instance share) | 0.03–0.05 | ~1 MB per user per month of samples after rollup. Raw payloads → S3 Parquet |
| Queues, scheduler, KMS, SES, S3 | <0.01 | |
| Observability (CloudWatch logs/metrics) | 0.02 | sample `connector.call.*` at 10% |
| **Total variable** | **≈ $2.35–2.50** | |

### 7.4 At scale

| MAU | Variable ($/mo) | Fixed platform floor ($/mo)* | Total ($/mo) | $/MAU |
|---|---|---|---|---|
| 1,000 | ~2.4k | ~3.5k | ~6k | ~6.00 |
| 10,000 | ~24k | ~5k | ~29k | ~2.90 |
| 100,000 | ~240k | ~12k | ~252k | ~2.50 |
| 1,000,000 | ~2.0M (volume pricing, provisioned throughput, Terra $0.003 tier) | ~40k | ~2.04M | ~2.05 |

\*Fixed floor = minimum Aurora capacity, NAT/ALB, the minimum running worker
fleet, Terra base plan, Redis, monitoring. It excludes people, legal and
certifications (§8), and pass-through COGS (lab kits, supplements, Stripe fees).
Those are covered by per-transaction margin or subscription price.

**Unit economics check:** at ~$2.50 per MAU, a €9.99/month premium tier has
~75% gross margin before payment fees. The free tier should be limited to the
**passive** profile (~$0.90 all-in).

### 7.5 Cost controls that are enforced, not advisory

1. **Per-user LLM budget** in `budget-guard.ts` (e.g. $4 per month standard,
   $12 power), using the `agent_runs.budget_usd/spent_usd` columns that exist
   today. When the budget runs out, runs degrade to rules-only nudges and don't
   fail.
2. **Per-run token cap and max tool calls per step** in the step executor.
3. **Prompt caching by construction:** a frozen system prompt + a
   deterministic tool order per user, with volatile context after the last
   cache breakpoint. Alert when `cache_read_input_tokens` falls below 50%.
4. **Batch** for all non-interactive generation (weekly reports, backfill
   summaries).
5. **Scanner/detector breaker:** reuse `dev-autopilot-scanner-breaker.ts`
   logic. A detector whose nudges are rejected more than 80% of the time gets
   auto-muted. Today's community autopilot has a 93% reject/expire rate, and it
   must not be repeated here.
6. The budget check in `orchestrator/budgets.ts` moves from **shadow → enforce**
   for the `agent_runtime` plane.

---

## 8. Safety, compliance and blockers

| Area | Requirement | Status / action |
|---|---|---|
| **Positioning** | Wellness coaching, not diagnosis or treatment. `medical-guard.ts` blocks dx/rx phrasing and stops on red flags. Localized disclaimers at plan and lab-result surfaces | **Legal review needed:** software that gives *individualized* diagnostic or therapeutic recommendations can qualify as a medical device under **EU MDR Rule 11**. Lab-result interpretation is the highest-risk surface. Recommendation: results are explained, and abnormal values are routed to a clinician (DoctorBox), never "treated" by the agent |
| **GDPR Art. 9** | Explicit, purpose-bound consent per connector and per data-sharing target. Withdrawal stops sync and deletes derived data on request | `data_sharing_consents` exists. Extend it to all PHI connectors. Add a DPIA |
| **EU AI Act** | Transparency that the member interacts with AI. Logging of automated actions | `action_ledger` + OASIS events cover logging |
| **Processors** | AWS (Bedrock, EU region), Terra/Vital, lab partners, Stripe → DPAs. Keep PHI out of non-EU processing where possible | Bedrock EU inference profile. Verify Terra/Vital data residency |
| **Token security** | KMS envelope encryption, scoped per-run credentials | **SEC-4 open**, fixed by §3.5 before any external write goes live |
| **Test accounts** | Agent test runs never reach real members (rules 43–45). Staging suites are read-only (rule 48) | Agent writes are proven with in-memory connector fakes in CI, never against real third parties with real accounts |
| **Blockers today** | Google/Microsoft OAuth clients not configured on staging/prod. No iOS/Android companion for HealthKit/Health Connect. VCAOP activation gates BLK-006/009/010. Policy/budget layer shadow-only | Each one is its own VTID |

---

## 9. Delivery plan

| Phase | Weeks | Scope | Exit criterion |
|---|---|---|---|
| **P0 Foundations** | 1–2 | Credential Vault + SEC-4 migration. Connector SDK v2 + manifest codegen. Ingest queue + DLQ. Oura/Whoop/Terra on manifests. Canonical schema + partitioning | Wearable data for a staging cohort flowing via webhooks, zero plaintext tokens |
| **P1 Runtime** | 2–4 | `agent-runtime` service. Run engine on `agent_runs`. PolicyGate + consent wired, **enforced**. Router tool-use extension + `agent_*` stages. Budget guard enforced. 4 playbooks | Regression suite green: in-memory DB + fake connectors, every policy tier covered |
| **P2 External actions** | 4–6 | Calendar writes, SES nudges, lab ordering (DoctorBox order API), Stripe mandate spend path, detectors (HRV, sleep debt, checkup overdue) | Staging read-only suite green. Writes proven in CI. Owner sign-off per `high` capability |
| **P3 Scale-out** | 6–12 | T2 MCP client + partner onboarding. Capability retrieval. Native companion app (HealthKit/Health Connect). T3 browser pilot on 1–2 booking sites, human-gated | 50+ connectors via manifests without gateway code changes |

---

## 10. Decisions needed from the owner

1. **Merchant of record for agent purchases.** Stay affiliate/hand-off only
   (D4), or let Vitana charge via Stripe for lab tests and services? This
   changes compliance and the payment connector scope.
2. **Launch countries**, which decide the lab partners and booking partners.
3. **Native companion app** for Apple Health / Health Connect: build our own,
   or ship the aggregator's mobile SDK?
4. **Free-tier limits**: passive-only profile, or a small monthly run
   allowance?
5. **Browser tier (T3)**: approve a gated pilot, or defer until T2 coverage is
   measured?
