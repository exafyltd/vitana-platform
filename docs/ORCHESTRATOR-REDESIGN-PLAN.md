# Vitana Orchestrator v2 — status analysis and build plan

**Status:** plan, 2026-09-23 (VTID-04316). Nothing in this document is built yet.
Inputs:
- a read-only audit of both repos (`vitana-platform`, `vitana-v1`);
- `docs/AGENT-REGISTRY.md` (VTID-04222) and `docs/OPERATOR-AGENT-BUILD-PLAN.md`;
- a survey of how production multi-agent systems are built in 2025–2026 (sources in §9).

**One-sentence verdict:** the original orchestrator
(`services/agents/vitana-orchestrator` plus the Python conductor/crew layer)
is dead or orphaned. The *real* orchestration moved piecemeal into at least
six separate control loops inside the gateway. Each loop has its own:
- state table,
- permission gate,
- trigger mechanism, and
- idea of "the user's role".

No single component knows who is asking, in which role, on which surface,
what they may do, what is running on their behalf, or what it costs.
Orchestrator v2 is that component: a **control plane inside the gateway**.
It is not a new "agent of agents" service.

---

## 1. What exists today (measured, not assumed)

### 1.1 The legacy orchestrator layer — why it is "off"

| Component | What it was | Status | Why |
|---|---|---|---|
| `services/agents/vitana-orchestrator` (ECS `vitana-vitana-verification-engine`) | Verification stage-gate for the VTID-01163 worker orchestrator. Its own README says it is *not* an orchestrator. | **Orphan**: running and heartbeating, never called | Its only caller (`worker-orchestrator-service.ts:23`) defaults `VERIFICATION_ENGINE_URL` to a dead Cloud Run URL. No task def sets the variable. The ECS service has no ingress. `VERIFICATION_MODE` is advisory, so nothing notices. |
| `services/agents/conductor` (+ `llm-router/router.py`) | Multi-agent conductor | **Dead code, zombie ECS container** | Routes to `vertex_ai`/`gemini`/`anthropic`. All three are banned (rules 10a/10b/27). No caller. |
| `agents/validator-core`, `agents/crewai-gcp` | Validator / CrewAI planner-worker | **Dead stubs, zombie ECS containers** | `/run` and `/execute` return canned success. |
| `services/worker-runner` | VTID-01200 autonomous execution plane | **Live, but only as a relay** | Its own LLM path is the direct Anthropic API, which has no key and is forbidden. It only claims `autonomous_execution`/self-healing rows and waits for the Dev Autopilot result. |
| `services/autopilot-worker` | `claude -p` queue worker | **Dormant** | Its gate `DEV_AUTOPILOT_USE_WORKER` is set nowhere. |
| `services/openclaw-bridge`, `services/oasis`, `services/deploy-watcher`, `services/mcp` + `services/mcp-gateway` (diverged twins) | Various | **Dead** | GCP-only, unbuildable (`services/oasis` copies a missing `approval.py`), or duplicated. |
| `services/gateway/src/services/ai-orchestrator.ts` | "AI orchestrator" | **Stub** | Returns static responses. |
| `agents_registry` table + `/api/v1/agents/registry` + Command Hub view | Agent roster and heartbeat | **Live but display-only** | Nothing routes work on it. Gateway-embedded agents and ECS executor tasks are not in it. |

**Security finding to act on first:** the ungoverned zombie containers
(`vitana-conductor`, `-validator-core`, `-crewai-*`, `-openclaw-bridge`,
`-planner-core`, `-worker-core`, `-qa-agent`) still carry the production
`SUPABASE_SERVICE_ROLE` and Aurora `DB_PASSWORD` secrets
(`docs/AURORA-MIGRATION-STATUS-2026-09-10.md`, 2026-09-11 addendum). They do
no useful work. They are pure attack surface and cost.

### 1.2 Where orchestration actually happens now — six loops, no conductor

| # | Plane | Entry point | State | Trigger | Permission gate | Role awareness |
|---|---|---|---|---|---|---|
| 1 | **ORB / Vitana Assistant** (voice + text, every role) | `orb-live.ts`, `live-session-controller.ts`, `orb-livekit.ts` + `orb-agent` | per-session memory only | user speaks | surface allowlist (`surface.ts`, `applySurfaceGate`) + `activeRole` checks + an exafy_admin marker for `operator_delegate` | surface is taken from the **route**, not the role; patient/professional/staff get the community catalog |
| 2 | **Operator Console** (Command Hub) | `routes/operator.ts` → `gemini-operator.ts` | `operator_threads`, `operator_messages` | developer types | `developerGate` + `isExecuteTaskAuthorized` (exafy_admin) | developer only |
| 3 | **Dev Autopilot** (code) | `dev-autopilot-*.ts`, `autopilot-agent/*` (ECS executor) | `dev_autopilot_executions`, `autopilot_recommendations(source_type='dev_autopilot')` | GH Actions cron scan, operator on-ramp, auto-approve tick | `dev_autopilot_config` allow/deny scope, safety gate, PR approval hold | n/a |
| 4 | **Self-healing** | `self-healing-*`, `dev-autopilot-bridge.ts`, worker-runner relay | `self_healing_log` → `dev_autopilot_executions` | E2E monitor, reconciler, CI failure | injector rules | n/a |
| 5 | **Community Autopilot** (AP-0100…AP-1600, 147 automations) | `automation-executor.ts`, `automation-handlers/*`, `recommendation-engine/*` | `autopilot_recommendations`, automation runs | Cloud Scheduler (**dead since 2026-08-15**; EventBridge migration not applied) | none per role beyond the registry's role sets | reads `user_tenants.active_role` only, which disagrees with the ORB's `role_preferences` |
| 6 | **BackOffice / Commerce** | `backoffice/command-orchestrator.ts`, `erp-bridge`, `partner-orgs.ts`, `admin-partner-health.ts`, `shopping-agent.ts` | `erp_commands`, `erp_approvals`, `erp_audit`, `partner_*` | web / voice / chat | **the best gate in the platform**: tiers, channel ceilings, maker-checker, capability grants | org roles (`org_admin`/`staff`/`professional`) are unknown to the ORB and to AP automations |

Plus several embedded mini-orchestrators: `pillar-agents/orchestrator.ts`,
`memory-orchestrator.ts`, `deploy-orchestrator.ts`, `assistant-continuation/decide-continuation.ts`
(wake-brief ranker), and `orb/delegation/*` (the user's own external AI accounts).

### 1.3 Role model today

- **Platform roles** (ladder): community < patient < professional < staff <
  backoffice < admin < developer < infra (`constants/vitana-roles.ts`).
  `exafy_admin` is a JWT flag, not a role.
- **Many roles per user.** `get_my_permitted_roles()` returns the union of
  grants, membership roles and `community`. The active role is switched with
  `set_role_preference` and every switch is audited.
- **A second, independent axis: organisation roles.** `partner_organization_members.role`
  is one of `org_admin`, `staff` or `professional`. It is entered through
  "business mode", which deliberately does not write `set_role_preference`.
- **Tenants:** `user_tenants` + `TenantProvider` (maxina, earthlinks, alkalma).
- **Two sources of "active role" disagree.** The ORB reads `role_preferences`,
  then falls back to `user_tenants.active_role`. The AP executor reads only
  `user_tenants.active_role`.
- **A per-role assistant policy already exists and is not enforced.**
  `intelligence/assistant-role-registry.ts` (VTID-03240) defines prompt,
  tools, memory and context per role. Problems:
  - It has no `backoffice` profile and no org roles.
  - `role-policy-enforcer.ts` runs in **shadow mode only**.
  - ORB tool names are not mapped onto it (TODO at `orb-tools-shared.ts:5870`).

### 1.4 Gaps per role × surface

| Role / mode | ORB today | What is missing |
|---|---|---|
| Community member | full community catalog (~290 tools), brain, continuation providers, AP nudges, recommendations | Proactive automations stopped when Cloud Scheduler died. Specialist personas (`sage`, `atlas`, `mira`, `devon`) are **draft**. `switch_persona` is a no-op. |
| Patient | same as community, plus 2 health-test tools | No patient-scoped agent (results explanation, lab follow-up). The lab report pipeline has no processor (VTID-04044). |
| Professional | same as community | Dashboard is static and Patients is a ComingSoon placeholder. There is no data for an agent to act on yet. |
| Staff | same as community | Queue is hardcoded demo data. |
| Admin (`/admin`) | `admin_orb` overlay + admin tools | Cannot delegate to any agent. No view of runs/costs across agents. |
| BackOffice (`/backoffice`) | `backoffice_orb` + 4 command tools, voice capped at Draft | Nothing proactive (overdue invoices, approvals waiting). |
| Commerce org (org_admin/staff/professional) | **no surface, persona or tools** | The ORB does not know business mode exists. |
| Developer (`/command-hub`) | dev read tools + `operator_delegate` (the only internal-agent delegation in the platform) | Delegation blocks for up to 25 s instead of running as an async job. Prod runs a different operator than staging (1 flag vs 14). |

---

## 2. What the industry learned (and what it means here)

Short version of the research (sources in §9):

1. **Use the simplest pattern that works.** Anthropic's *Building effective
   agents* orders the options: a single call, then workflows
   (routing / chaining / parallel / orchestrator-workers / evaluator-optimizer),
   and only then autonomous agents. Anthropic's multi-agent research system
   beat a single agent by 90% on research tasks, but used about **15× the
   tokens**. It pays off only for wide, parallelizable work.
2. **Many thinkers, one writer** (Cognition, *Don't Build Multi-Agents*,
   plus its later update). Parallel agents that each write produce
   conflicting results. Specialists should *return findings*, and one agent
   commits.
3. **Two delegation modes** (OpenAI Agents SDK):
   - *handoff*: the specialist takes over the conversation;
   - *agent-as-tool*: the front agent stays in charge.

   For a voice assistant with one persona, agent-as-tool is the default.
4. **Task ledger + progress ledger + stall counter** (Microsoft Magentic-One).
   The orchestrator records facts and a plan once, then on every round checks:
   is the task done, is it looping, is it making progress. It re-plans or
   stops after N rounds without progress. This is the published cure for
   runaway loops. Our executor already rediscovered pieces of it (VTID-04016
   repeated-check guard, VTID-04243 turn-cap snooze).
5. **Durable execution** (Temporal / DBOS / Inngest / Restate). Model and
   tool calls are recorded activities. Human approvals and CI results are
   *signals* to a waiting workflow, not reasons to keep a process alive.
   Our history of watchdogs reclaiming live runs (VTID-04011) and state lost
   on container churn is exactly the problem this solves. DBOS-style
   "workflow state in Postgres" fits our stack without a new service.
6. **Governance separate from the agents.** Converging practice:
   - tiers (read / draft / commit / high);
   - maker-checker;
   - capability grants scoped to tenant, role and user;
   - per-run and per-tenant budgets;
   - global and per-agent kill switches;
   - an append-only audit log;
   - model/provider fallback treated as an alert.

   OWASP *Agentic Top 10* (Dec 2025) and LLM06 *Excessive Agency* are the
   threat model. Our ERP command orchestrator already implements most of this.
7. **Voice needs async.** A voice agent must never sit silent on a slow tool.
   Current practice (LiveKit async tools, 2026) is:
   - acknowledge immediately;
   - start a durable job with an id;
   - narrate progress and allow cancellation;
   - dedupe with an idempotency key;
   - deliver the result as a later turn or a push.
8. **Agent cards + MCP.** Each agent is described machine-readably (A2A Agent
   Card: skills, inputs/outputs, auth). Tools are exposed through one tool
   plane (MCP) with per-role allowlists.
9. **Observability.** OpenTelemetry GenAI conventions: an `invoke_agent`
   span for each run, with `chat` and `execute_tool` child spans carrying
   tokens and cost. Each agent gets an eval set of 20–50 real tasks, graded
   by an LLM judge and spot-checked by humans, which gates prompt and model
   changes.

---

## 3. Target design — Orchestrator v2

**Principle:** Orchestrator v2 is a **control plane** in the gateway that
every agent path goes through. It is not a new LLM persona that
"manages" other LLMs. Most turns never need a second agent. The
orchestrator's job is to make every agent run:
- **known**: registry;
- **allowed**: policy;
- **durable**: run ledger;
- **observable**: telemetry;
- **routed to the right specialist when one is actually needed**: dispatcher.

```
 Channels:  ORB voice/text (per role+surface) · Operator Console · Admin UI · BackOffice UI
            · Commerce portal · Scheduler (EventBridge) · OASIS events · CI/GitHub webhooks
                                        │
                     ┌──────────────────▼──────────────────┐
                     │ 1. Principal & Context Resolver      │  user, tenant, platform role, org role,
                     │    (one function, used everywhere)   │  surface, channel, locale, exafy flag
                     ├──────────────────────────────────────┤
                     │ 2. Intent Router / Dispatcher        │  single agent? tool? specialist? async job?
                     ├──────────────────────────────────────┤
                     │ 3. Policy Engine (generalised ERP)   │  capability · tier · channel ceiling ·
                     │                                       │  maker-checker · budget · kill switch
                     ├──────────────────────────────────────┤
                     │ 4. Run Ledger + durable state machine│  agent_runs, run_steps, signals, leases,
                     │                                       │  progress ledger, idempotency
                     ├──────────────────────────────────────┤
                     │ 5. Agent Registry v2 (agent cards)   │  skills, roles, surfaces, stage, tier cap,
                     │                                       │  budget, owner, eval status, health
                     ├──────────────────────────────────────┤
                     │ 6. Telemetry, cost, evals            │  OTel GenAI spans → OASIS; Command Hub view
                     └──────────────────────────────────────┘
                                        │
 Workers (existing, kept):  ORB front agents · Operator · Agent executor (ECS) · Planner · Validator
   · Self-healing triage · Architecture investigator · Memory jobs · AP automation handlers
   · Recommendation engine · Shopping agent · BackOffice command orchestrator/erp-bridge
   · Partner-health pipeline · Pillar agents · (new) role specialists
```

### 3.1 Principal & Context Resolver

One function, `resolveAgentContext(req | session | job)`, returns:

```
{ user_id, tenant_id,
  platform_role,            // active, from role_preferences → user_tenants fallback (ONE rule)
  permitted_roles[],        // get_my_permitted_roles()
  org: { org_id, org_role, commerce_vertical } | null,   // business mode
  surface,                  // vitanaland | admin | backoffice | command-hub | commerce (new)
  channel,                  // voice | chat | web | system | ci
  exafy_admin, locale, aal }
```

- Replaces `resolveEffectiveRole` (ORB), the AP executor's
  `user_tenants.active_role` read, `developerGate`/`adminGate`, and the
  surface-from-route guess. The ORB still sends `current_route`; the
  resolver treats it as one input, not the answer.
- **Business mode becomes a surface** (`commerce`), so the ORB can serve
  org_admin/staff/professional with their own overlay and tools.
- A role switch mid-session is an explicit event (`orchestrator.context.switched`).
  The run ledger can then attribute runs to the role they were created under
  and deliver results back to that role (see §4.1).

### 3.2 Policy Engine — generalise the ERP pattern to every agent action

Lift `backoffice/command-policy.ts` into a domain-neutral `orchestrator/policy/`:

- **Capability catalog per domain:** community, health, professional,
  staff, admin, backoffice, commerce, dev, ops. Each tool or action
  declares:
  ```
  { domain, action, tier: read|draft|commit|high,
    requester_capabilities[], approve_capability?, escalation_rules[] }
  ```
- **Role → capability grants**, seeded from `assistant-role-registry.ts`
  (add backoffice and org roles), plus per-user grants
  (`erp_capability_grants` becomes `agent_capability_grants`).
- **Channel ceilings:**
  - voice ≤ draft (commit only with an explicit spoken confirm for
    low-risk, *user-own* actions: log water, set reminder, RSVP);
  - chat ≤ commit;
  - web can approve;
  - system/scheduler per automation spec.
- **Maker-checker for `high`:**
  - the requester can never approve;
  - approval on the web screen only;
  - MFA (aal2);
  - never confirmable by voice.
- **Budgets:** per run, per agent/day, per tenant/day (tokens + USD from
  `llm.call.*`). Exceeding a budget is a policy denial, not a crash.
- **Kill switches:** global (`EXECUTION_DISARMED`, kept), per agent
  (registry `enabled`), per tenant.
- **Rollout:** `role-policy-enforcer.ts` already has the shadow harness.
  Map ORB tool names onto the catalog, run shadow for two weeks, read the
  denial log, then enforce per surface.

### 3.3 Run Ledger + durable state machine

One generic table family that unifies `dev_autopilot_executions`,
self-healing rows, AP automation runs and ORB async jobs **as views on top
of their existing tables at first**, then natively:

- `agent_runs` columns:
  ```
  id, parent_run_id, root_run_id, agent_id, principal (ctx snapshot), vtid?,
  intent, status, tier, idempotency_key, budget_usd, spent_usd, lease_owner,
  lease_until, created_via (voice|chat|web|scheduler|event|ci),
  deliver_to (surface+role+channel), result_ref, error
  ```
- `agent_run_steps`: append-only; model calls, tool calls, observations.
  This is the progress ledger.
- `agent_run_signals`: approval, rejection, CI result, cancel, user reply.
- **Generic states:**
  ```
  queued → running → (waiting_signal | awaiting_approval) → running → succeeded | failed | cancelled
  ```
  Domain sub-states stay in their own table; the Dev Autopilot keeps
  `ci/merging/deploying/verifying`.
- **Leases, not heartbeats-as-truth.** The claim/lease protocol of
  `routes/worker-orchestrator.ts` (atomic claim, `claimed_until`, autonomy
  allowlist) is sound and gets reused. A lease is renewed by run steps, so
  a live run is never reclaimed as dead.
- **Progress ledger / stall detection.** Every loop records per round:
  progress yes/no, looping yes/no, next action. After N non-progress rounds
  it re-plans once, then stops. This generalises VTID-04016/04243.
- **Durability choice:** stay in Postgres (DBOS-style workflow tables +
  the existing ticks) rather than adding Temporal. The platform already runs
  all state in Postgres with tick loops. What is missing is a uniform step
  journal and resumable steps. Revisit Temporal only if the tick loops
  become the bottleneck.

### 3.4 Intent Router / Dispatcher

Decides, per request, the **cheapest adequate pattern**:

1. **Direct tool:** most ORB turns. No new agent; policy check only.
2. **Single specialist as a tool** (agent-as-tool): the front agent keeps
   the persona and calls e.g. `ask_health_specialist`,
   `ask_commerce_specialist`, `ask_operator`, and speaks the result.
3. **Async job:** anything likely to take more than ~1.5 s in voice, or any
   commit/high-tier work. The run is created, the user hears an
   acknowledgement, and the result comes back as a continuation candidate
   (`decide-continuation.ts` already ranks such candidates), a push, or an
   inbox item.
4. **Orchestrator-workers fan-out:** only for wide, parallel investigation
   (self-healing root cause, architecture investigation, multi-source
   research). Workers read; one writer commits.
5. **Evaluator-optimizer:** code changes (agent → tsc/jest/CI → fix round).
   This is the existing executor loop.

`operator_delegate` (VTID-04310) is the first instance of pattern 2/3. It is
generalised into `delegate_to_agent(agent_id, request)`, and the registry +
policy decide which agent ids each role/surface may call.

### 3.5 Agent Registry v2 (agent cards)

Extend `agents_registry` from a heartbeat roster into the catalog the
dispatcher routes on. One row (and one A2A-style JSON card) per agent:
- `skills[]`, `domains[]`, `roles_allowed[]`, `surfaces_allowed[]`;
- `llm_stage`, `max_tier`, `budget_per_run`, `budget_per_day`;
- `owner`, `eval_suite`, `eval_pass_rate`, `enabled`, `health`.

It covers gateway-embedded agents and ECS task agents, not only services
that heartbeat. `docs/AGENT-REGISTRY.md` becomes generated from it.

### 3.6 Telemetry, cost, evals

- OTel GenAI spans (`invoke_agent` → `chat`/`execute_tool`), exported as
  OASIS events keyed by `run_id`, with tenant, role, agent, tokens and cost.
- A Command Hub **Orchestrator** view: runs by plane/role/agent, stalled
  runs, awaiting-approval queue, spend vs budget, fallback alerts, and a
  kill switch per agent. This is where the existing nine Autopilot tabs'
  supervisor strip (VTID-04282) naturally lives.
- **Evals:** 20–50 real tasks per agent, LLM-judge on the `validator`
  stage, human spot checks. Any prompt, model or policy change must pass
  before promotion. Voice evals use the ORB Voice Bench for the audio half.

---

## 4. How each part of Vitanaland plugs in

### 4.1 One user, many roles, one ORB per role

- The front agent for a session is selected by `(surface, platform_role, org_role)`
  from the registry, not only by route.
  - **Surfaces:** vitanaland (community/patient/professional/staff overlays),
    admin, backoffice, commerce (new), command-hub.
  - **Each overlay:** persona prompt, tool catalog = capabilities granted
    for that context, memory scope, continuation providers.
- **Memory scoping:** personal memory (health, diary) is visible only in
  personal roles. Work memory (backoffice, commerce, dev) is visible only in
  the matching work context. Cross-role reads need an explicit capability.
  This protects health data from leaking into a staff or commerce session
  and vice versa.
- **Runs follow the role that created them.** A job started as backoffice
  delivers its result to the backoffice surface/inbox, not into a community
  voice session. If the user is in another role when it finishes, the
  continuation ranker offers a one-line "you have a backoffice result
  waiting — switch?" and never reads the content out in the wrong context.
- **A role switch** mid-conversation re-resolves the context and swaps the
  tool catalog on the next turn. It never silently carries write
  capabilities across.

### 4.2 Community member / patient / professional / staff

- **Community:** activate the draft specialists as *agent-as-tool*
  specialists (support, account, finance/refunds) behind the Vitana
  persona, instead of the no-op `switch_persona`. Move the AP engine's
  triggers to EventBridge through the orchestrator's scheduler channel, so
  every automation run is an `agent_run` with budget, role and
  notification policy.
- **Patient:** a health specialist (results explanation, follow-up plans)
  runs as async jobs. It becomes the consumer of the missing lab-report
  processor (Bedrock vision → `biomarker_results`), which is its own VTID.
- **Professional / staff:** the orchestrator cannot invent data these
  roles do not have yet (static dashboards, ComingSoon Patients). Plan the
  surfaces and capability rows now; attach agents when the product data
  exists.

### 4.3 Admin

- Admin ORB gets `delegate_to_agent` for admin-safe agents: tenant
  analytics, automation health, moderation queue, recommendation tuning.
  Tier ceilings apply (voice ≤ draft).
- Admin UI gains the tenant-scoped slice of the Orchestrator view:
  automations running for my tenant, spend, failures, kill switch per
  automation.

### 4.4 Commerce portal / BackOffice

- A new `commerce` surface + `commerce_orb` overlay for org roles:
  - partner onboarding assistant;
  - catalog ingest checks;
  - health-order inbox triage;
  - DoctorBox result matching (draft only; confirm on web).
- BackOffice keeps its command orchestrator. It becomes the reference
  implementation the Policy Engine is extracted from. Add proactive
  continuation providers (approvals waiting, overdue items) behind the
  same tiers.
- Shopping agent stays propose-only (draft tier). Checkout is `high` and web-only.

### 4.5 Developer: Command Hub, Operator, Autopilot, self-healing

- **Operator Console** = the developer front agent. Everything it queues
  is an `agent_run`. The console's follow-through (VTID-04033) reads the
  run ledger.
- **Dev Autopilot** keeps its executor, watchers and fix mode. Its
  `dev_autopilot_executions` rows are projected into `agent_runs` first,
  then migrated. The concurrency cap, budgets and turn-cap snooze become
  orchestrator policy instead of scattered constants.
- **Self-healing** fans out (investigator + triage + log/DB readers in
  parallel, read-only), then hands exactly one fix to the executor (one
  writer).
- **worker-runner is retired.** Its only live job, relaying self-healing
  VTIDs, is subsumed by the run ledger's claim protocol. This also ends the
  `AUTOPILOT_LOOP_ENABLED` double-dispatch hazard.
- **Session plane (Claude Code sessions)** stays outside autonomous
  claiming, exactly as VTID-03516 requires. Sessions can *read* the run
  ledger for context.

### 4.6 Voice specifics (all roles)

- Latency budget: the front agent never blocks more than ~1.5 s on a tool.
  Longer work becomes an async run: acknowledge in the model's own words
  (NEVER-rule 41), keep listening, deliver through continuation or push.
- Cancel by voice ("stop that") maps to `agent_run_signals(cancel)` for runs
  the user started.
- A voice session can never confirm `commit` for another user's data or
  any `high` action.

---

## 5. Build plan (phases, each shippable and staging-verified)

Each phase gets its own VTID(s) at start (self-allocated, §4.1 of CLAUDE.md).
Merges deploy to staging only; production is the owner's PUBLISH.

| Phase | Scope | Acceptance (observable on staging) | Owner decisions / risks |
|---|---|---|---|
| **P0 — Truth & cleanup** (1 wk) | Retire dead code: conductor, validator-core, crewai-gcp, `services/oasis`, deploy-watcher, one MCP twin, `ai-orchestrator.ts` stub; remove the dead verification-engine URL default. Fold verification validators into `agent-validate.ts` or retire the ECS service. Unify active-role resolution into one helper used by the ORB + AP executor. | No code path references `*.run.app`; AP executor and ORB resolve the same role for the same user (test); registry lists every live agent. | **Owner:** stop the zombie ECS services and remove the prod secrets from their task defs (IAM the sessions do not hold). |
| **P1 — Context + Registry v2 + Run Ledger (shadow)** (2 wk) | `resolveAgentContext`; `agents_registry` extended to agent cards (migration); `agent_runs`/`agent_run_steps`/`agent_run_signals` created; Dev Autopilot, self-healing and AP runs written as *projections* (no behaviour change). Command Hub Orchestrator view v0 (read-only). | Every run of every plane visible in one list with role, agent, cost; zero behaviour change (existing suites green). | Schema review; `DATABASE_SCHEMA.md` updated. |
| **P2 — Policy Engine (shadow → enforce)** (2–3 wk) | Extract `command-policy.ts` into `orchestrator/policy`; capability catalog for community/health/admin/backoffice/dev; map ORB tool names (closes the `orb-tools-shared.ts:5870` TODO); `role-policy-enforcer` shadow for 2 weeks, then enforce per surface; budgets from `llm.call.*`. | Shadow denial log reviewed; enforcement on `/admin` and `/backoffice` first with no false denials; budgets block a synthetic over-spend in a unit/integration test. | Which default grants per role (product decision). |
| **P3 — Dispatcher + async jobs in the ORB** (2–3 wk) | `delegate_to_agent` generalising `operator_delegate`; async tool pattern (ack → run → continuation/push → cancel); first specialists as agent-as-tool: support/account (community), commerce onboarding (new `commerce` surface). | On staging a voice request that needs >1.5 s returns an acknowledgement at once and delivers the result on a later turn; `stop that` cancels; a result created as backoffice is not spoken in a community session. | Push-notification copy via `tt()` catalog; persona activation of the draft specialists. |
| **P4 — Dev planes on the ledger** (2 wk) | Dev Autopilot + self-healing write natively to the run ledger; leases replace the running-watchdog; progress-ledger stall detection in executor + stage loops; worker-runner retired; self-healing fan-out → one writer. | A live run is never reclaimed while stepping; a looping run stops with a `stalled` reason; no double dispatch; Test Run with a fix-mode child completes end to end. | Retiring worker-runner ECS service (owner). |
| **P5 — Community autopilot on the orchestrator** (2 wk) | AP automations dispatched as `agent_runs` from EventBridge (reuse `setup-eventbridge-cron-migration.sh`); per-tenant budgets, role-aware targeting from the unified resolver; test-account exclusion enforced centrally (rules 43–45). | First AP run since 2026-08-15 executes on staging data read-only paths; no test/service account ever targeted (test). | `--apply` of the EventBridge script is owner-run; real-member notifications need explicit go-ahead. |
| **P6 — Patient / admin / professional / staff agents** (ongoing) | Health specialist (after the lab-report processor VTID), admin delegation set, professional/staff surfaces once their data exists. | Per-agent eval suite passing before enablement. | Product priorities. |
| **P7 — Observability, evals, prod parity** (parallel from P1) | OTel GenAI spans → OASIS; eval suites per agent gated in CI; prod operator flag parity (VTID-04230 pins); deactivate `vertex`/`anthropic` catalog rows; fix three `deepseek-chat` fallbacks. | Eval dashboard green before each promotion; `llm.call.*` shows zero anthropic/vertex; prod operator = staging operator. | Promotion via PUBLISH; catalog deactivation affects prod immediately. |

**Critical path:** P0 → P1 → P2 → P3. P4 and P5 can run in parallel after P1.
P7 starts with P1.

---

## 6. What not to build

- **No LLM "super-agent" that chats with other agents** to decide what to
  do. Routing is a deterministic function of context + registry + policy,
  with an LLM classifier only for ambiguous intents (`classifier` stage).
- **No second workflow engine** until the Postgres ledger is proven
  insufficient.
- **No parallel writers.** Parallel reads, a single commit.
- **No voice-confirmable `high` actions**, ever.
- **No duplicate policy tables per plane.** One catalog, many domains.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Big-bang rewrite breaks working loops (Dev Autopilot just reached end-to-end completions) | Projection first, native later. Every phase is shadow → enforce with rollback by flag. |
| Policy enforcement blocks real users | Two-week shadow per surface, then enforce behind a per-surface flag. |
| Latency regression in the ORB | Policy checks are pure, in-memory functions (like `evaluateCommand`), with a p99 budget in tests; the catalog is cached per session. |
| Cost growth from multi-agent patterns | Budgets are policy; fan-out only in pattern 4; spend visible per run. |
| Prompt injection through member content, CI logs, memory | Retrieved text is data; tools read-only by default; writes jailed; memory writes screened (OWASP ASI06). |
| Health-data leakage across roles | Memory scoping by context (§4.1); capability required for cross-role reads. |

## 8. Open decisions for the owner

1. Approve retiring the zombie ECS services and removing their production secrets (P0).
2. Default capability grants per role, and which specialists to activate first (P2/P3).
3. Whether business mode becomes a first-class ORB surface (`commerce`) (recommended: yes).
4. EventBridge `--apply` for the community automations, and whether they may notify real members (P5).
5. Retire `worker-runner` and `autopilot-worker`, or keep `autopilot-worker` as an optional Claude-CLI lane.
6. Budget ceilings per tenant/day and per agent/day.

## 9. Sources

- Anthropic, *Building effective agents* — https://www.anthropic.com/engineering/building-effective-agents
- Anthropic, *How we built our multi-agent research system* — https://www.anthropic.com/engineering/multi-agent-research-system
- Cognition, *Don't Build Multi-Agents* — https://cognition.com/blog/dont-build-multi-agents
- LangChain, *How and when to build multi-agent systems* — https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems
- OpenAI Agents SDK, handoffs / guardrails — https://openai.github.io/openai-agents-python/handoffs/ , https://openai.github.io/openai-agents-python/guardrails/
- LangGraph human-in-the-loop — https://docs.langchain.com/oss/python/langchain/human-in-the-loop
- Microsoft Magentic-One — https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/ , https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic
- Google ADK + A2A — https://adk.dev/a2a/
- AWS Bedrock multi-agent collaboration / AgentCore — https://docs.aws.amazon.com/bedrock/latest/userguide/agents-multi-agent-collaboration.html , https://aws.amazon.com/blogs/machine-learning/building-multi-tenant-agents-with-amazon-bedrock-agentcore/
- Durable execution — https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai , https://www.inngest.com/blog/ai-orchestration-with-agentkit-step-ai
- OWASP Top 10 for Agentic Applications (2026) — https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/ ; LLM06 Excessive Agency — https://genai.owasp.org/llmrisk/llm062025-excessive-agency/
- OpenTelemetry GenAI agent spans — https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
- LiveKit async tools for voice agents — https://livekit.com/blog/async-tools-voice-agents
