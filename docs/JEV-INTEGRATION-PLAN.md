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
6. The community cost policy in §8.5: per-user quotas, and community browser jobs off by default.
7. Which Drive holds the back-office documents, and whether scanned PDFs are in scope (they need Amazon Textract OCR first).
8. Whether to ask TypeSafe for an enterprise tier early. The 1,200 requests/min limit is reached before cost becomes a problem (§8.4).

## 8. Use cases by role, and cost awareness

Added 2026-09-25 at the owner's request. Every use case is listed by role, with who pays and how much.

### 8.1 What actually costs money

The owner's expectation, stated in their request:
- Internal roles (developer, admin, back office, staff) may use Jev without limits, because it helps the team run the business.
- Community use needs cost awareness.

The numbers change where the risk actually sits:

| Cost item | Unit price | Billed by | Notes |
|---|---|---|---|
| **Jev decision** | $0.042 per 1M **input** tokens; output free | **TypeSafe, a separate invoice** | Jev is **not on AWS Marketplace** (checked 2026-09-25), so it does **not** count against the AWS budget. A typical decision of ~1,000 tokens costs **$0.000042**; 1 million decisions cost **$42**. |
| Bedrock Claude Sonnet 4.6 (what several classifiers use today) | $3 per 1M input + $15 per 1M output | AWS | The same ~1,000-token classification with ~50 output tokens costs **≈$0.0038**. That is **~90× the Jev price**. |
| DeepSeek Flash (`operator` stage) | $0.15 / $0.60 per 1M | DeepSeek | ≈$0.00018 per call; Jev is still ~4× cheaper. |
| Browser worker (Fargate, 2 vCPU / 4 GB, eu-central-1) | ≈$0.11 per hour (list price, to re-check) | AWS | A 5-minute job costs ≈$0.01 of compute. |
| One browser job, end to end | ≈$0.03–0.05 | AWS + TypeSafe | ≈40 steps × 3k tokens of Jev (≈$0.005), plus a few Bedrock text calls (≈$0.02), plus compute (≈$0.01). |
| Amazon Textract (scanned documents only) | ≈$1.50 per 1,000 pages (to re-check) | AWS | Only for image PDFs; Jev accepts text only. |

**Three consequences:**
1. **A single Jev decision is almost free.** The community cost risk is not Jev itself. It is **what a Jev decision triggers**: a browser job, a Bedrock call, a push notification or a paid API.
2. **Wherever Jev replaces an existing Bedrock classification, it saves money.** Jev can lower total AI spend rather than add to it.
3. **Before cost, the binding limit is the vendor rate limit**: 1,200 requests/min for the whole account during early access. Heavy community traffic could crowd out the team's internal decisions. That needs separate quotas, not a larger budget (§8.5).

### 8.2 Internal roles: unlimited use, still metered

These roles run the business. Per the owner's rule they have **no per-call limits**. Spend is still recorded (`decision.call.*` → the existing `orchestrator/budgets.ts` view), so a runaway loop shows up. It is never throttled for being a legitimate volume.

#### Back office (`backoffice` role, BackOffice / ERP)

| # | Use case | Jev question(s) | Volume and Jev cost | Benefit |
|---|---|---|---|---|
| B1 | **Find the ~200 relevant documents among 10,000 in a Drive** (the owner's example) | Per document, one call with parallel questions. Examples: `noul` "is this a signed partner contract?", `choice` document type, `score` relevance to the search brief. | 10k docs × ~4k tokens = 40M tokens ≈ **$1.70 per full sweep**. At 1,200 rpm ≈ 9 min. The same sweep on Sonnet ≈ $120+. | Hours of manual work become minutes. |
| B2 | Classify incoming invoices and receipts to the chart of accounts | `choice` over accounts (≤255 per question; split larger charts) | 1,000 docs/month ≈ $0.10 | Faster bookkeeping. The ERP Draft card still asks a human to confirm. |
| B3 | Contract clause checks | `noul`: auto-renewal? notice period > 3 months? exclusivity? liability cap present? | ≈$0.0002 per contract | Risk found before signing. |
| B4 | CRM lead scoring and routing | `score` fit, `choice` owner or team | Negligible | The sales team works the right leads first. |
| B5 | Pre-screen a command's risk before maker-checker | `choice` suggested tier | Negligible | The approver sees a hint. **The tier itself stays in `command-policy.ts` code.** |
| B6 | Affiliate commission reconciliation | `noul` "does this payout match this order?" | Negligible | Revenue leakage found. |
| B7 | Shared inbox routing (info@, partners@) | `choice` team, `noul` urgent | Negligible | Faster response. |
| B8 | Partner portal and supplier form automation (Jev Ultrafast, Phase 4) | Jev picks the action on each step | ≈$0.03–0.05 per job | Repetitive portal work automated. Payment, signature and final submit stay human-gated. |

B1 in practice:
- Jev is a **classifier, not a search index**. The pipeline is: list the Drive → extract text (Textract only for scans) → optional cheap keyword or pgvector pre-filter (the existing `knowledge-hub`) → Jev per document → a ranked list → a human opens the hits.
- Documents above ~32k tokens are chunked, and the best chunk score counts.
- Reading Drive through the Google Workspace API is a data source, not a Google model. It does not conflict with the "no Google LLM routing" rule, but it needs its own OAuth scope and owner approval.

#### Admin (tenant admins, exafy admins, Command Hub business side)

| # | Use case | Jev question(s) | Benefit |
|---|---|---|---|
| A1 | Content moderation queue ranking (posts, comments, chat reports) | `score` severity, `choice` policy category | Worst items first. **Removal stays a human decision.** |
| A2 | Campaign audience selection (which members fit a campaign) | `noul` per member on anonymised profile enums | Better targeting. Test and service accounts are excluded in code first (rule 45). |
| A3 | Partner and merchant application screening | `score` completeness, `noul` category fit | Faster onboarding. KYB stays human (VCAOP human gate). |
| A4 | Notification fan-out gate: "is this notification relevant for this segment?" | `noul` | Less notification fatigue, fewer unsubscribes. |
| A5 | Tenant health summary buckets | `choice` status per signal | A quicker morning overview. |
| A6 | Feedback and review theme clustering | `choice` over a fixed theme list | Product decisions from real member voice. |

#### Staff and support (`staff`, Devon specialist)

| # | Use case | Jev question(s) | Benefit |
|---|---|---|---|
| S1 | Ticket triage: bug / how-to / account / billing | `choice` | Replaces an LLM call in the intake path. |
| S2 | Duplicate ticket detection | `noul` "same issue as ticket X?" against the top-N candidates | Fewer duplicate fixes. |
| S3 | Priority and urgency | `score` | Critical tickets first. |
| S4 | Hand-off readiness: "is the summary specific enough?" | `noul` (augments `isVagueSummary`) | Fewer vague tickets reaching Devon. |
| S5 | Escalation and distress detection in a support conversation | `noul` | Safety. A human is always paged; Jev only raises the flag. |

#### Developer and infra (Command Hub, Dev Autopilot, self-healing)

| # | Use case | Jev question(s) | Benefit |
|---|---|---|---|
| D1 | OASIS error-event triage: which service, severity, known pattern? | `choice` service, `score` severity, `choice` over the known-incident catalog | Faster root-cause start. Cheaper than the current `triage` stage call. |
| D2 | CI failure bucketing: test / type error / infra / dependency | `choice` | Better routing for the self-heal bridge. **"Flake" is never an accepted verdict on its own.** |
| D3 | Dev Autopilot finding de-duplication across scanners | `noul` "same finding?" | Fewer duplicate executions (a known defect class). |
| D4 | Operator Console tool-group routing | `choice` over tool groups | Smaller tool catalog per turn, so faster and cheaper turns. |
| D5 | Spec quality gate before planning | `score` completeness per criterion | Fewer planner round trips. |
| D6 | Voice session self-healing classifier (replaces `classifyVoiceSession`'s LLM call) | `choice` | Cheaper and faster. |
| D7 | Alert de-duplication (Google Chat / SNS alerts) | `noul` | Less alert noise. |
| D8 | PR risk hint for reviewers | `score` | Review focus. **Merge and approval gates stay in code.** |

**Internal volume estimate** (generous): 200k decisions/month ≈ 200M tokens ≈ **$8.40/month** of Jev. B1 sweeps and B8 browser jobs are extra and small. A realistic internal Jev bill is **under $50/month**. Replacing D1/D6/S1 LLM calls likely **reduces** the Bedrock line by more than that.

### 8.3 Community users: long list, with a cost class

Every community use case gets one of three cost classes:
- **Class A — saves money.** Jev replaces an existing LLM call. Always on, no quota.
- **Class B — Jev only.** No downstream cost beyond Jev. On, with a generous per-user daily quota as a runaway guard.
- **Class C — triggers expensive downstream work** (browser job, Bedrock generation, paid API, push fan-out). Only when **revenue-linked or explicitly entitled**, with a hard quota.

The last column says whether the use case earns revenue for Vitanaland.

| # | Community use case | Jev question(s) | Class | Revenue? |
|---|---|---|---|---|
| C1 | Intent routing of an utterance (today `classifyIntentKind` → Bedrock) | `choice` | **A** | no, but saves cost |
| C2 | Voice tool pre-selection per turn (tool groups) | `choice` | **A** | no, but faster and smaller prompts |
| C3 | Marketplace intent (today an LLM tool call) | `choice` | **A** | **yes**, the first step to a sale |
| C4 | Product and service shortlist soft-fit ranking (price and distance stay in code) | `score` per candidate | B | **yes** (affiliate, marketplace) |
| C5 | Booking readiness: missing slot, needs clarification? | `noul` / `choice` | B | **yes** (bookings) |
| C6 | Coach, doctor and practitioner compatibility | `score` | B | **yes** (professional bookings) |
| C7 | Event and ticket fit | `score` | B | **yes** |
| C8 | Deal and offer relevance | `noul` | B | **yes** (affiliate) |
| C9 | Retrieval routing: memory vs knowledge vs web | `choice` | B | no |
| C10 | "Is this worth remembering?" before a memory write | `noul` | **A**, fewer memory-extraction LLM calls | no |
| C11 | Diary entry mood and topic tag (fixed lists) | `choice`, `score` | B | no |
| C12 | Daily log category (sleep / water / exercise…) | `choice` | B | no |
| C13 | Proactive nudge gate: "should Vitana reach out today?" | `noul` | B, gates push cost | no, retention |
| C14 | Notification relevance per member | `noul` | B, **reduces** push volume | no, retention |
| C15 | Group and connection recommendation fit | `score` | B | no, engagement |
| C16 | Community post safety pre-screen | `score` | B, **mandatory** | no, safety |
| C17 | Distress and escalation signal in conversation | `noul` | B, **mandatory; never quota-blocked** | no, safety |
| C18 | Journey step completion check ("did the member understand?") | `noul` | B | no |
| C19 | Support ticket self-triage (member side of S1) | `choice` | **A** | no |
| C20 | "Book it for me" on an external site with no API (Jev Ultrafast) | browser job | **C** | **yes** only if a paid booking or commission results |
| C21 | Price or availability watch on external sites | recurring browser job | **C** | weak; **off** for community |
| C22 | Form filling for the member (insurance, registration) | browser job | **C** | no; **off** (also the PII and consent risk) |

Health-data rule:
- Any use case touching lab results, patient records or health metrics (the patient role) keeps health values **out of Jev state**.
- Only enums derived in code may be sent, for example "has new lab report: yes/no".
- This follows the §3.1 minimal-state rule and the open DPA question (Phase 0).

### 8.4 Community cost model

Assumptions:
- An active member triggers **≈30 Jev decisions per day** (voice turns, intents, shortlists, gates) at ≈1,000 tokens each.
- That is 900 decisions ≈ 0.9M tokens per member-month ≈ **$0.038 per active member per month** for Jev.

| Active members | Jev decisions / month | Jev cost / month | Bedrock saved if C1/C2/C10 replace a Sonnet call¹ | Rate-limit status (1,200 rpm ≈ 52M/month if perfectly flat) |
|---|---|---|---|---|
| 500 (today's tenant is ~450) | 0.45M | **≈$19** | ≈$500 | fine |
| 10,000 | 9M | **≈$380** | ≈$10k | peaks will hit the limit → needs enterprise quota |
| 100,000 | 90M | **≈$3,800** | ≈$100k | **over the limit**; enterprise tier required |

¹ This column assumes roughly a third of the decisions replace a Bedrock Sonnet classification that runs today. It is an upper bound until Phase 1 shadow data shows the real replacement ratio.

**The expensive part is Class C.**
- 10,000 members × 1 browser job/day × $0.04 ≈ **$12,000/month**. That alone is over the $10k envelope.
- This is why Class C is off by default for community, and only allowed when it produces revenue:
  - a confirmed booking or purchase with commission, or
  - a paid entitlement.
- In either case there is a hard monthly quota per member.

One heavy member making 1,000 Class B decisions a day costs ≈ $1.26/month in Jev. That is irrelevant for money. It matters only as rate-limit pressure.

### 8.5 Cost controls to build (additions to Phases 1–4)

1. **Every Jev call carries a `plane`: `internal` or `community`**, plus `tenant_id` and `role`.
   - This closes the gap `budgets.ts` names itself ("per-tenant budgets need a tenant on the telemetry row").
   - `decision.call.*` events include them.
2. **Two TypeSafe API keys**: one for internal planes, one for community.
   - The community key has its own share of the vendor rate limit, so member traffic can never starve back office, admin or developer decisions.
   - If the vendor cannot split limits per key, the gateway enforces the split with a token bucket per plane.
3. **Per-member daily quotas, configurable in `decision_policy`** (the existing table):
   - Class A: no quota. Over quota it would only fall back to the more expensive LLM path, so a quota would raise cost.
   - Class B: default 300/day, as a runaway guard; over quota → the deterministic fallback.
   - Class C: default 0 per member; entitlement-based (e.g. 3 bookings/month); over quota → "I can show you the options, but I can't book this one for you".
   - Safety cases C16/C17 are **exempt from every quota**.
4. **Budget views**:
   - `budgets.ts` gains a `jev` line and a `community` line alongside the platform line.
   - Community Class C gets its own daily ceiling (proposed $50/day ≈ $1.5k/month).
   - Crossing it turns Class C off for the rest of the day and pages the owner. It never silently degrades.
5. **Command Hub panel** "Decisions & cost":
   - decisions/day by plane and class, the fallback rate, Jev $ vs Bedrock $ saved, top members by Class C usage, and quota hits.
6. **Revenue attribution for Class C**: every browser job records the `order_id` / `booking_id` it produced. The weekly report shows cost per converted booking, so the "revenue-linked" rule is measured, not assumed.

### 8.6 Summary per role

| Role | What Jev does for them | Cost stance |
|---|---|---|
| Developer / infra | Faster incident, CI and finding triage; cheaper Operator turns | Unlimited, metered; net saving vs today |
| Admin | Moderation ranking, audience selection, partner screening | Unlimited, metered |
| Back office | Document search at scale (B1), bookkeeping, contracts, portal automation | Unlimited, metered; B1 costs ~$2 per 10k-document sweep |
| Staff / support | Ticket triage, duplicates, priority, safety flags | Unlimited, metered |
| Professional / partner | Lead fit (VAEA), listing quality, catalog categorisation | Metered, generous quota; revenue-linked |
| Community | Faster, cheaper voice and routing (A); better recommendations and safety (B); "book it for me" only when it earns (C) | A always on; B quota as runaway guard; C off unless revenue-linked or entitled |

## Sources

- TypeSafe API reference — https://docs.typesafe.ai/api
- TypeSafe models, limits, pricing — https://docs.typesafe.ai/models
- TypeSafe quick start — https://docs.typesafe.ai/introduction/quickstart
- TypeSafe legal (DPA, ZDR) — https://docs.typesafe.ai/legal
- OpenRouter TypeSafe SDK guide — https://openrouter.ai/docs/guides/community/typesafe-sdk
- Jev Ultrafast repository — https://github.com/browser-use/jev-ultrafast
- Independent deep dive (latency, limitations) — https://flaviocopes.com/jev/
- Launch coverage — https://www.tomshardware.com/tech-industry/artificial-intelligence/typesafe-ais-jev-offers-an-alternative-to-llms-that-claims-to-be-193x-faster-and-445x-cheaper-system-one-type-model-is-bespoke-for-probabilistic-decision-making
