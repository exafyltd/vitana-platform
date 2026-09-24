# Jev (TypeSafe "System One") Integration Plan — VTID-04473

**Status:** plan only. Nothing here is built, deployed or configured. Every
flag named below is proposed, defaults OFF, and lands staging-first.
**Date:** 2026-09-24. **Scope:** `exafyltd/vitana-platform` (gateway + VCAOP);
no `exafyltd/vitana-v1` change is needed until Phase 3.

There are two separate things, and they get two separate integrations:

| | What it is | Where it goes in Vitana |
|---|---|---|
| **Jev** (decision model) | Hosted API. Takes a `state` and typed `questions`, returns typed `answers` with calibrated probabilities. Writes no text. | A new **decision adapter** in the gateway, used through one `jev-decision-service` module. **Not** a provider in `llm_routing_policy`. |
| **Jev Ultrafast** | MIT-licensed Python browser agent (Browser Use). Jev picks the click/type target, and a small text LLM writes the typed text. | A new **`BrowserDriver`** behind VCAOP's existing `BrowserConnector` and guardrails, running as an ECS task. |

---

## 1. What the web research actually established

Checked 2026-09-24 against `docs.typesafe.ai` (API, Models, Quickstart,
Legal), the OpenRouter TypeSafe SDK guide, `github.com/browser-use/jev-ultrafast`,
and independent write-ups.

### 1.1 Jev API facts — and where the brief's sketch is wrong

The sketch in the original brief uses question types and answer fields
that do not exist. The real contract:

- **Endpoint:** `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`.
  - OpenRouter mirror: `POST https://openrouter.ai/api/v1/systemone`.
  - It is **not** chat-completions, so no existing adapter in `llm-router.ts` can call it.
- **Models:** `jev-latest` (currently `jev-1.13.0`) and `jev-preview`. Pin the version, never `-latest`, in production.
- **Question types:**

  | Type | Fields | Answer |
  |---|---|---|
  | `noul` (yes/no) | `instructions`, optional `criteria:{true,false}` | `noul` ∈ [0,1] |
  | `choice` | `instructions`, `criteria` = map option→description (≤255 options) | `choice`, `probabilities`, `confidence` |
  | `score` | `instructions`, `criteria` = ordered 2–10 level descriptions | `score`, `legend`, `probabilities`, `confidence` |

  **Corrections to the brief:**
  - There is no `"type":"boolean"`; the yes/no type is `noul`.
  - A choice question takes a `criteria` map, not an `options` array.
  - The response does not have the shape `{value, probability}`.
  - The response carries `usage.input_tokens` / `usage.output_tokens`.
- **Errors:** `401`, `422` (validation), `429` (rate limit), `529` (overloaded). The SDKs retry with backoff.
- **Limits:**
  - 64k tokens per request; state plus the longest question ≤ 32k.
  - **Text only** — no audio or images.
  - 1,200 requests/min and 250k tokens/s, "adjusting dynamically" during early access.
- **Price:**
  - $0.042 per million **input** tokens; output is free.
  - A 1,000-token decision costs ~$0.00004, so cost is not a factor in any decision below.
- **Latency:**
  - Vendor claim: 70–500 ms end to end, most calls ~100 ms, measured from the US West Coast.
  - Independent OpenRouter test: median 0.33 s, max 1.42 s over 791 calls.
  - **We call from `eu-central-1`**, so add a transatlantic round trip. The goal is to measure it (Phase 0), not assume it.
- **Early access since 2026-09-15.** Nine days old; rate limits and behaviour will move.
- **Known weaknesses (vendor + independent):**
  - Arithmetic, counting, dates and mixed number formats.
  - Double negatives.
  - Large irrelevant state degrades accuracy.
  - Adversarial input.
  - **English gives the best accuracy; other languages are "handled but not equally well".**
- **Data:**
  - Customer data is not used for training.
  - **Zero data retention (ZDR) is enterprise-only on request** (`privacy@typesafe.ai`).
  - A DPA exists.
  - Processing region is **not documented** — assume US.
- **SDKs:** `typesafe-sdk` (Python) and `@typesafe-ai/sdk` (JS, per OpenRouter). We use plain `fetch` (section 3.3) so no new dependency enters the gateway.

### 1.2 Jev Ultrafast facts

- **How it works:**
  - Serialises the visible DOM into a numbered element table.
  - Jev picks an operation (`CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_UP/DOWN`, `WAIT`, `DONE`, `BLOCKED`) and a target in one call.
  - Only on `TYPE_TEXT` does a second text model write the text (the demo uses `inception/mercury-2.5` via OpenRouter).
- **Safety property worth keeping:** model output never becomes selectors, coordinates, JS or shell commands. Targets are resolved from observed DOM nodes, with occlusion checks.
- **Runtime:** Python + `uv`, Browser Harness, Chrome with remote debugging. Env vars: `TYPESAFE_API_KEY`, `TEXT_MODEL_API_KEY`.
- **MVP limits (per the README):**
  - No shadow roots, iframes, canvas, file uploads, pop-up tabs, nested scrolling or custom keyboard widgets.
  - "Requires independent outcome verification."
  - One demo task at 3/3 success.
  - **Not production-grade**; treat it as a driver to evaluate, not a platform.

---

## 2. What the Vitana codebase already has (the decisive part)

The plan is shaped by what exists. Four findings matter most.

1. **Nothing in Vitana calls a model the Jev way.**
   - `llm-router.ts` (`callViaRouter`, `ADAPTERS`, `LLMProvider` in `constants/llm-defaults.ts:41`) is text-in/text-out plus tools.
   - Jev's request/response has no place in `AdapterCallArgs`/`AdapterResult`.
   - Forcing it into `llm_routing_policy` would also let a stage "fall back" from Jev to Bedrock text, and back. That is exactly the silent-fallback shape standing rules 10c/35 forbid.
   - **Decision:** Jev gets its own typed client, its own `decision.call.*` telemetry, and no routing-policy row.
2. **There is already a shadow slot built for a fast tool-router.**
   - Pieces: `runWithShadow` (`services/llm-router-shadow.ts:189`, flag `FEATURE_SHADOW_TOOL_ROUTER_ENV`, emits `eval.shadow.compared`), the stub `predictVoiceToolRoute` (`services/voice-tool-router-candidate.ts:29`, which currently just echoes the primary's tool), the call site `routes/orb-live.ts:3180`, and `scripts/auto-promoter.ts`.
   - The stub's own header says "swap the body for a real call to the served candidate model; the call site does not change."
   - **That is Jev's first integration point**, measured against real traffic with zero user-facing risk.
3. **The bounded decisions Jev is good at exist today, done by a full LLM or by regex.** Each one below is an atomic choice/yes-no decision:

   | Decision today | File | How it's done now | Jev fit |
   |---|---|---|---|
   | Intent kind of a voice/text utterance | `services/intent-classifier.ts:137` (`classifyIntentKind`) | `callClaudeText` → Bedrock directly, **bypassing the router** (no fallback, no telemetry) | `choice` — strong |
   | Marketplace intent | `orb-tools/marketplace-guide-tools.ts:347` (`classify_marketplace_intent`) | LLM tool call | `choice` — strong |
   | Voice tool pre-selection / tool groups | `orb/live/tools/session-tool-selection.ts:72` (`routeToolGroups`), `orb-live.ts:8406` | static rules | `choice` over tool groups — strong (also shrinks the 226 KB catalog problem, VTID-04026/04097) |
   | Buying-intent scoring (VAEA) | `services/vaea/src/classifier/intent-classifier.ts` | **v0 regex heuristic**, header says "keep scoring axes identical so the swap is trivial" | 5 × `noul`/`score` axes — near drop-in |
   | Retrieval routing | `services/retrieval-router.ts:368` | keyword rules + priorities | `choice` — medium, rules are cheap and deterministic already |
   | Support-ticket vagueness / hand-off readiness | `report-to-specialist-core.ts:238` (`isVagueSummary`) | heuristic | `noul` — medium |
   | Self-healing voice session class | `services/voice-session-classifier.ts:111` | LLM | `choice` — medium |

4. **The confirmation, policy and browser-safety layers already exist. Do not rebuild them.**
   - `services/orchestrator/policy.ts`:
     - `PolicyTier = none|read|draft|commit|high`, with `evaluateToolCall` (L196).
     - Shadow recording in `policy-shadow.ts`, budget in `budgets.ts`.
   - `services/consent-gate.ts`:
     - `createPendingAction` / `approvePendingAction`.
     - Purchase and post always require consent regardless of grants.
   - BackOffice `command-orchestrator.ts` provides maker-checker.
   - **VCAOP** (`services/vcaop/`) already has:
     - `BrowserConnector` over a swappable `BrowserDriver` (the Skyvern/Stagehand slot, still mock-only).
     - An isolated profile per (provider, account).
     - `no-pii-leak` scrubbing of every artifact.
     - `human-gate` (CAPTCHA, KYB, PAYOUT, IRREVERSIBLE_SUBMIT, TRANSFER → human task).
     - `no-captcha-solve`, `no-credential-store`, `env-boundary` (fail-closed to "prod" = refuse), and `cost-guard`.
     - A required CI gate.
   - The brief's list of browser-worker controls (isolated profile, audit screenshots, kill switch, mandatory approval before payment/signature/final submit) is **already this module's contract**.
   - **Decision:** Jev Ultrafast is a new `BrowserDriver` implementation here, not a new fleet with new rules.

**Gaps found:**
- There is **no booking tool**: nothing in `orb-tools/` has "book" in its name. `browse_wellness_services`, `search_services_by_need` and `find_free_slot` exist.
- There is **no SQS usage anywhere**.
- The only worker dispatch is ECS `RunTask` (`services/aws-ecs-admin.ts:50`, `dispatchExecutorJobAws`).
- There is **no shared PII redaction helper** in the gateway. VCAOP's `no-pii-leak.ts` is the only one.

---

## 3. Target architecture

```text
User (voice / chat)
  │
  ▼
ORB session (Nova Sonic / cascade / Vertex-sr)  ── understands speech, writes the reply
  │  structured turn state (English-normalised fields, no raw PII)
  ▼
Gateway orchestrator (orb-live, orb-tools, orchestrator/*)
  ├─ jev-decision-service  ── typed questions → Jev ── typed answers
  │        └─ thresholds + deterministic fallback (existing code path) live HERE
  ├─ existing tools: marketplace, calendar, cart, services_catalog
  ├─ orchestrator/policy.ts + consent-gate.ts   ← decides confirmation, never Jev
  └─ browser job (only when no API exists) ──► VCAOP BrowserConnector
                                                 └─ JevUltrafastDriver (ECS task)
                                                      ├─ Chromium + Browser Harness
                                                      ├─ Jev (action choice)
                                                      └─ Bedrock (TYPE_TEXT only)
```

### 3.1 Rules the design obeys

These are the platform's standing rules applied to Jev:

- **Jev never decides whether to act; code does.** Every Jev answer is an input to deterministic code that already exists: the policy tier, the consent gate or the human gate. A Jev probability never waives a confirmation. Purchase, booking, payment, signature, health data and legal consent always confirm.
- **Explicit fallback, never silent.** When Jev fails, times out or falls below its threshold, the call site runs **the code path it runs today** (the regex, the rule, or the LLM). It emits `decision.call.fallback` with the reason. There is no Jev→LLM retry disguised as success.
- **Minimal state.**
  - The state carries only the fields a question needs.
  - It never carries the conversation transcript by default, and never names, emails, phone numbers, health values, memory facts or tenant identifiers.
  - It is redacted through a gateway port of VCAOP's `no-pii-leak` (section 3.4).
- **English-normalised state.** DE is Vitana's source language, and Jev is weakest outside English. The state therefore carries the fields the ORB model already extracted (intent slots, enum values) in English, and option/criteria text is English. A raw German utterance is only sent in Phase 0 measurement, to quantify the gap.
- **No Google, no `anthropic`.** Ultrafast's `TYPE_TEXT` model is **Bedrock Claude** (`eu.anthropic.claude-sonnet-4-6`, the invokable profile, §2b) or DeepSeek Flash, never the demo's OpenRouter default.
- **Test-account exclusion.** Anything a browser job does on behalf of a member respects `fetchExcludedTestServiceAccountIds`, and never writes as a test account (VTID-03506 / rule 43).

### 3.2 Flags (all default off, exact-`'true'` convention)

| Flag | Gates |
|---|---|
| `JEV_DECISIONS_ENABLED` | the client itself; unset → `not_configured`, every call site uses its current path |
| `JEV_SHADOW_ENABLED` | shadow calls (result logged, never used) |
| `JEV_DECISION_<NAME>_LIVE` | one per decision (e.g. `JEV_DECISION_INTENT_KIND_LIVE`) — promotes that single decision from shadow to live |
| `VCAOP_JEV_DRIVER_ENABLED` | the browser driver; live runs additionally need VCAOP's existing `allowLive` |
| `JEV_MODEL` | pinned model id, default `jev-1.13.0` |
| `JEV_TIMEOUT_MS` | per-call budget, default 400 (voice) / 1500 (non-voice) |

### 3.3 Gateway module layout

```text
services/gateway/src/services/jev/
  jev-client.ts          fetch → /v1/systemone, AbortController timeout, 429/529 backoff (1 retry max on voice),
                         not_configured when JEV_DECISIONS_ENABLED!=='true' or no TYPESAFE_API_KEY
  jev-types.ts           Noul/Choice/Score question + answer types, runtime validation of every answer
                         (choice ∈ declared options, probabilities sum≈1) — a malformed answer = fallback
  decisions/             one file per decision: builds state, fixed question schema, threshold, mapping
    intent-kind.ts
    tool-group.ts
    marketplace-intent.ts
    booking-readiness.ts
  jev-decision-service.ts   decide(name, input) → { source:'jev'|'fallback', value, probability, reason }
  jev-telemetry.ts       decision.call.started|completed|failed|fallback OASIS events
                         (name, model, latency_ms, input_tokens, cost_usd, probability, fell_back, reason) —
                         never the state itself
```

- The `decisions/*` files are the **only** place a question schema lives. Each has a golden test pinning its schema, so changing a question is a reviewed diff.
- `MODEL_COSTS` gets a `jev-1.13.0` row, so `estimateCost` covers it in the telemetry the Command Hub already reads.
- The internal HTTP surface proposed in the brief (`POST /internal/decisions/...`) is **not needed**. Every caller is inside the gateway process, so it calls `jev-decision-service` directly, which saves a hop. One read-only admin route, `GET /api/v1/admin/decisions/stats`, is added for the dashboard.

### 3.4 PII port

- Move VCAOP's `no-pii-leak` field and regex rules into a shared package, or copy them into `services/gateway/src/lib/pii-redaction.ts` with a parity test (the VTID-03706 drift-test pattern).
- `jev-client.ts` calls `assertPiiFree(state, 'llm_prompt')` before every request, and fails closed to fallback.

### 3.5 Secrets and infra

- Add `scripts/aws/setup-typesafe-secret.sh`, a clone of `setup-fish-audio-secret.sh`: dry run by default, `--apply`, and a `vitana/gateway/<env>/typesafe-api-key` secret.
- Wire it into `AWS-STAGE-DEPLOY-GATEWAY.yml` with the **optional `describe-secret` pattern** (erp-bridge / operator-sql-readonly style), never the hard-fail loop, until the secret is confirmed to exist.
- Prod is untouched until promotion.
- Egress: the gateway already reaches the internet. The browser task's security group allows 443 to the internet only, with no VPC-internal access beyond the gateway (section 5).

---

## 4. Phased rollout

Each phase is its own VTID and PR, and staging only. Production is reached by PUBLISH or an approved pinned dispatch.

### Phase 0 — Vendor and data gate (no code in prod paths)

Blocking questions, owner decisions:
1. **DPA and region.** Vitana is a health/wellness platform with EU members (GDPR Art. 9 context).
   - Sign TypeSafe's DPA.
   - Ask for **ZDR** and the processing region.
   - If there is no EU processing and no ZDR, Jev may only see non-personal, English-normalised enums. Section 3.1 already designs for that, but legal must confirm.
2. **Account and key.** Direct TypeSafe or via OpenRouter?
   - Recommended: **direct** (one fewer sub-processor, the documented DPA).
   - OpenRouter stays as a documented backup base URL only.
3. **Latency from eu-central-1.** A one-off benchmark script, `scripts/jev/bench-jev.mjs`:
   - 200 calls of the real `intent-kind` schema, run from an ECS task in `eu-central-1`.
   - Report p50/p90/p99.
   - **Go/no-go for voice use: p90 ≤ 400 ms.** Non-voice decisions are fine up to ~1.5 s.
4. **Language gap.** The same benchmark runs a labelled set (≥100 utterances per language, DE/EN/ES/SR) twice: once raw, once English-normalised. It records the accuracy delta. The labelled set is built from existing, non-PII `oasis_events` intent logs, or hand-written. **No production writes.**

**Exit:** DPA signed or explicitly scoped, a p90 number, and an accuracy table. If voice p90 > 400 ms, Phase 2's voice items drop out and only non-voice decisions proceed.

### Phase 1 — Client + shadow on real traffic

- Ship `services/jev/*`, the secret script, and the optional staging secret wiring.
- **Shadow only** (`JEV_SHADOW_ENABLED`):
  1. `predictVoiceToolRoute` makes a real Jev `choice` over the session's tool groups. `eval.shadow.compared` then measures agreement with Nova/Vertex's actual tool, and `scripts/auto-promoter.ts` already consumes it.
  2. `classifyIntentKind`: Jev runs alongside `callClaudeText`, and agreement is logged.
  3. VAEA `classifyIntent`: Jev scores the same 5 axes in shadow, compared against the heuristic. VAEA is itself in observe mode, so no user impact at all.
- Tests:
  - Client unit tests: timeout, 429/529, malformed answer → fallback, `not_configured`, PII assertion refusal.
  - Golden schema tests per decision.
  - A source test that no `decisions/*` file sends a field named in the PII list.

**Exit:** ≥2 weeks of staging shadow data. Per decision, record agreement, latency and the fallback rate.

### Phase 2 — Promote bounded decisions, one flag at a time

Promote a decision only if its shadow agreement is ≥ the owner-set bar (proposed: 95% at the chosen threshold) **and** its p90 fits its path.

| Order | Decision | Replaces | Threshold → below it |
|---|---|---|---|
| 2a | `intent-kind` | `callClaudeText` in `intent-classifier.ts` | p ≥ 0.80 → else existing Claude path |
| 2b | `marketplace-intent` | LLM call in `classify_marketplace_intent` | p ≥ 0.80 → else existing path |
| 2c | `vaea-buying-intent` | v0 regex | score axes → VAEA still observe-only; promotes the classifier, not posting |
| 2d | `tool-group` (voice) | `routeToolGroups` static rules | p ≥ 0.85 → else static rules; **only if Phase 0 p90 ≤ 400 ms** |
| 2e | `ask-clarification` | new: `noul` "is a required slot missing / ambiguous?" feeding the existing clarify tools (`clarify_shopping_need`) | ≥ 0.75 → ask |

- Each promotion is a staging flag flip, verified by `decision.call.completed` with `source:'jev'`.
- Rollback is the flag.
- `orchestrator/policy.ts`, `consent-gate.ts` and the human gates are untouched in every step.

### Phase 3 — Wellness booking flow (the brief's worked example)

The example ("sports massage near Calvià tomorrow afternoon under €90") needs a **booking tool that does not exist yet**. The plan builds it API-first:

1. The ORB model extracts slots (service, location, date, time_period, max_price, home_visit) through an existing tool call. That is the structured state.
2. Jev answers, in one call with parallel questions:
   - `next_step` (choice): `search_providers | ask_clarification | show_existing_booking | handoff_support`.
   - `needs_exact_time` (noul).
   - `slot_ambiguity` (noul).

   **Date arithmetic stays in code.** Jev is documented as weak on dates, so "tomorrow" → `2026-09-25` is resolved by the gateway before the state is built.
3. The search uses the existing `search_services_by_need` / `services_catalog` and `find_free_slot`.
4. Ranking: Jev `score` per candidate on the *soft* fit only (description vs. need). Price filters, distance and availability are deterministic code, never Jev.
5. **New `book_service` tool:**
   - Tier `commit` in `orchestrator/policy.ts`.
   - Always goes through `consent-gate.createPendingAction` (side effect `purchase`).
   - Its confirmation is spoken by the ORB model and accepted by the user. Never Jev.
6. Frontend (vitana-v1): a confirmation card only when the booking is not voice-confirmed. All strings through i18n (DE first), RTL-safe.

### Phase 4 — Jev Ultrafast as a VCAOP browser driver

**Only for partner portals with no API, and only in VCAOP's dev/staging posture.** VCAOP's `env-boundary` refuses prod by design. Taking it to production is a separate, later decision that also clears VCAOP's open blockers.

1. **`services/browser-worker/`** (Python, `uv`, Debian + Chromium base image, **not** alpine):
   - Wraps `jev_ultrafast.Agent`.
   - Pinned to a commit SHA, vendored with a lock file (the ERPClaw pattern, `erpclaw.lock.json`).
   - Input: a job record, ID only, fetched from the gateway.
   - Output: a result plus artifacts, scrubbed before upload.
   - The `TYPE_TEXT` model is Bedrock via the task role, not OpenRouter.
2. **Dispatch:** a new `dispatchBrowserJobAws(jobId)` next to `dispatchExecutorJobAws`:
   - Same `RunTask`, FARGATE, awsvpc, no public IP, with `ecs:StopTask` as the kill switch (the VTID-04032 pattern).
   - **No SQS in v1.** The platform has none, and a `browser_jobs` table plus the dispatch loop and lease (`orchestrator/run-lease.ts`) already give queue semantics.
   - Add SQS only if concurrency needs it.
3. **`JevUltrafastDriver implements BrowserDriver`** in `services/vcaop/src/connectors/providers/`:
   - `isLive = true`.
   - `runFlow` submits the job and polls the result.
   - Every guardrail in `BrowserConnector` runs unchanged: CAPTCHA → human task, irreversible submit → human gate, artifacts via `scrubBrowserArtifact`.
4. **Guard additions specific to Ultrafast:**
   - Stop on `BLOCKED`.
   - Treat any detected `<form>` submit, payment field or checkbox labelled consent/terms as `IRREVERSIBLE_SUBMIT` → human gate. Detection runs on DOM heuristics in the worker, not on Jev's opinion.
   - A per-job allowlist of target domains, enforced in the worker by a request-interception layer.
   - Step cap (40) and wall-clock cap (10 min) via `cost-guard`.
   - Refuse the job when the page uses iframes, shadow DOM or file uploads, the documented unsupported set. Refuse rather than let it half-work.
   - Post-run **independent outcome verification** (the README's own requirement): the worker re-reads the page state against the job's expected outcome and reports mismatch as failure.
5. **Job record** (`browser_jobs`, service_role-only RLS, migration applied only on approval):
   - `id, tenant_id, requested_by, target_domain, purpose, allowed_actions[], requires_confirmation, status, step_count, result_ref, artifacts_ref, audit_log_ref, created_at, finished_at`.
   - No credentials. Portal credentials are `*_ref` to Secrets Manager (`no-credential-store`).
6. **Infra:**
   - An ECR repo and task definition `vitana-browser-worker`.
   - A deploy workflow `AWS-STAGE-DEPLOY-BROWSER-WORKER.yml` (workflow_dispatch).
   - A task role scoped to `bedrock:InvokeModel` + its own secrets + S3 artifact prefix.
   - A security group with egress 443 only.
   - All provisioned by an owner-run `scripts/aws/setup-browser-worker.sh` (dry run by default). Sessions have no `iam:*` (recorded repeatedly in the CHANGE LOG).
   - New ECS resource ⇒ its own VTID (NEVER rule 1).
7. **Evaluation:**
   - Recorded HTML fixtures (a local static server) in CI. `allowLive=false` in CI, as today.
   - Live runs only against a partner portal's **sandbox or test tenant**, never a real member's account, and never against our own production.

### Phase 5 — Voice hot-path optimisation (conditional)

Only if 2d holds up in production:
- In the cascade (`cascaded-live-client.ts:584` `runTurn`), when Jev says with p ≥ 0.9 that a turn needs no tool, send the Bedrock call **without the tool catalog**. That is a smaller prompt, with no tool round trip.
- Measure with `voice.latency.measured` before and after.
- Nova Sonic is unchanged: it decides tools natively inside one bidirectional stream, and a pre-classifier cannot remove a hop there.

---

## 5. Risks and how the plan answers them

| Risk | Answer in this plan |
|---|---|
| Health/personal data leaves the EU to a 9-day-old US vendor | Phase 0 legal gate; minimal English-normalised state; PII assertion fails closed; ZDR requested |
| Jev weaker in German/Serbian | English-normalised state; Phase 0 measures the gap per language; per-language promotion possible |
| Latency from Frankfurt kills the voice benefit | Phase 0 p90 gate; voice decisions drop out if it fails; timeouts fall back to today's path |
| Early-access rate limits (1,200 rpm) / 529 overload | Bounded retry; fallback path; decisions are optional by design, so an outage degrades to today's behaviour, never to failure |
| Silent fallback hides Jev failure (the Gemini-bill pattern) | `decision.call.fallback` event with reason; `GET /admin/decisions/stats` fallback rate; morning health check gets a fallback-rate row |
| Probabilities trusted as guarantees | Jev feeds code; `policy.ts` / `consent-gate` / `human-gate` decide confirmation, untouched |
| Model drift under `jev-latest` | Pinned `JEV_MODEL`; golden-schema tests; re-run the Phase 0 set on each version bump |
| Ultrafast is an MVP (no iframes/uploads, one demo task) | Lives behind VCAOP's `BrowserDriver` interface, so it is swappable; refuses unsupported pages; independent outcome verification; dev/staging only |
| Browser agent reaching real accounts / submitting | Per-job domain allowlist, `IRREVERSIBLE_SUBMIT` human gate, CAPTCHA never solved, no credentials in DB, kill switch via `StopTask` |

---

## 6. What is explicitly out of scope

- Using Jev to write any user-facing text (it cannot, and NEVER-rule 41 keeps spoken wording model-composed).
- Putting Jev into `llm_routing_policy` or letting any stage fall back to or from it.
- Payments, signatures or legal declarations by the browser agent, ever. These are human-gated by VCAOP's existing contract.
- Running Ultrafast against production member accounts or against Vitana's own production.

## 7. Owner decisions needed before Phase 1

1. Direct TypeSafe account vs. OpenRouter (recommended: direct), and who signs the DPA / requests ZDR.
2. Whether any personal field may ever enter Jev state (recommended: none, enums only).
3. The promotion bar for Phase 2 (proposed 95% shadow agreement).
4. Whether Phase 3's `book_service` should target `services_catalog` providers only in v1 (recommended).
5. Whether Phase 4 proceeds now or waits for VCAOP's own production blockers.

## Sources

- TypeSafe API reference — https://docs.typesafe.ai/api
- TypeSafe models, limits, pricing — https://docs.typesafe.ai/models
- TypeSafe quick start — https://docs.typesafe.ai/introduction/quickstart
- TypeSafe legal (DPA, ZDR) — https://docs.typesafe.ai/legal
- OpenRouter TypeSafe SDK guide — https://openrouter.ai/docs/guides/community/typesafe-sdk
- Jev Ultrafast repository — https://github.com/browser-use/jev-ultrafast
- Independent deep dive (latency, limitations) — https://flaviocopes.com/jev/
- Launch coverage — https://www.tomshardware.com/tech-industry/artificial-intelligence/typesafe-ais-jev-offers-an-alternative-to-llms-that-claims-to-be-193x-faster-and-445x-cheaper-system-one-type-model-is-bespoke-for-probabilistic-decision-making
