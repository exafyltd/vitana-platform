# Watcher / Reminder Agent — Build Plan

**VTID-03454** · Status: plan (Phase 0) · Repo: `exafyltd/vitana-platform`
· Last updated: 2026-07-31

---

## 0. What this is, in one paragraph

A **Watcher** that observes every step of the development lifecycle
(finding → VTID → plan → execute → CI → merge → deploy → verify →
terminalize), writes what actually happened into a durable **engineering
memory**, and then feeds that memory back as **short, targeted reminders**
injected into the planner, the executor, and the worker-runner at the exact
moment each is about to make the same mistake again. It observes and
reminds. It does not execute, does not merge, does not deploy.

The problem it solves is already documented in this repo's own history:

- `CLAUDE.md` changelog, 2026-07-29 — VTID-03419's doc-update step "was
  apparently never pushed before that session's context was summarized."
  The infrastructure change was real; the paper trail describing it was
  lost with the session. A second session had to rediscover it.
- `BOOTSTRAP-ORB-FASTSTART-DRIFT` — "the var is set" did not mean "the
  feature is on" (`'staging-only'` resolves to dead in prod). That lesson
  now lives in a changelog row nobody reads at the moment it matters.
- `dev_autopilot_prompt_learnings`' own migration comment — "future
  plan/execute prompts keep repeating the same class of mistake."

Every one of those is the same failure: **the system knew, and forgot at
the moment of use.**

---

## 1. Ground truth — what already exists

Per `CLAUDE.md` ALWAYS rule 9 ("prefer existing systems") and NEVER rule 5
("never rebuild systems that already exist"), the Watcher is assembled
mostly from parts that are already here. What exists today:

| Piece | File / table | What it already does | Gap for our purpose |
|---|---|---|---|
| **Lifecycle state machine** | `services/gateway/src/services/dev-autopilot-watcher.ts` (854 L) | Drives `ci → merging → deploying → verifying → completed`; 3 independent 60 s ticks; failure paths route to `bridgeFailureToSelfHealing` | Advances state; **remembers nothing**. No durable record of *why* a transition happened |
| **Narrow learnings store** | `dev_autopilot_prompt_learnings` | Upserts worker validation failures (`tsc_error`, `jest_failure`, `parse_error`, `out_of_scope`, `validation_other`) keyed by `(pattern_type, pattern_key, scanner)`; read back into plan/execute prompts (last 14 d, limit 5) | **Only pre-PR validation.** Nothing from CI, merge, deploy, verify, revert, or human review. Scoped to `scanner`, so it can't serve the worker-runner (which has no scanner). Not reachable from any non-autopilot path |
| **Signal liveness verdicts** | `services/gateway/src/services/awareness-watchdogs.ts` | Manifest of 10 watchdogs, each joins `oasis_events` by `topic` → `pass`/`fail`/`partial`/`unknown` | Great *shape* to copy (typed-array manifest, no schema change to add one). Read-only, request-time, ORB-scoped |
| **Event spine** | `oasis_events` | `vtid.lifecycle.*`, `vtid.stage.*`, `vtid.decision.*`, `vtid.error.*` | The raw material. Deliberately excludes polling/heartbeats (§6) — good, and the Watcher must not change that |
| **Execution lifecycle** | `dev_autopilot_executions` | 15 statuses: `queued, cooling, cancelled, running, ci, merging, deploying, verifying, completed, failed, reverted, self_healed, failed_escalated, auto_archived` | Current state only; transition history is not first-class |
| **Execution plane** | `services/worker-runner/` (VTID-01200) | register → heartbeat → poll → claim → route → execute → complete → terminalize | `execution-service.ts` builds the LLM call with **zero** access to prior-attempt memory |
| **Self-healing family** | `self-healing-{triage,diagnosis,injector,reconciler,snapshot,spec,probe,metrics}.ts` | Reacts to a failure by spawning a fix | Reactive per-incident; no cross-incident pattern memory |

**Conclusion:** we do not need a new agent runtime. We need (a) a durable
timeline the watcher writes, (b) a generalized memory that subsumes
`dev_autopilot_prompt_learnings`, and (c) one retrieval surface that all
three consumers call.

---

## 2. Hard constraints this design must respect

Non-negotiable, from `CLAUDE.md`:

1. **No new service.** NEVER rule 1 — "never invent new projects,
   environments, or services." The Watcher ships as a **module inside the
   gateway** (`services/gateway/src/services/watcher/`) plus tables plus
   `/api/v1/watcher/*` routes. No Cloud Run service, no ECS service, no
   task definition, no §1b table row.
2. **Ticks are not events.** §6 — "OASIS is for STATE TRANSITIONS and
   DECISIONS — not loops. Polling ≠ progress." The Watcher's own scan loop
   emits **nothing** to `oasis_events`. Only a *decision* (a reminder was
   raised, a rule was found violated) is event-worthy.
3. **Watchers never write to the DB from workers.** NEVER rule 9 — all
   mutations go through gateway APIs.
4. **Never run parallel VTID executions.** The Watcher is an observer; it
   must never claim, execute, or terminalize a VTID.
5. **Best-effort, never blocking.** Follow the existing
   `loadExecutionLessons()` pattern: wrapped in try/catch, returns `[]` on
   any DB issue, so a Watcher outage can never stall an execution.
6. **Governance events on real transitions only** (ALWAYS rule 7), and
   **fail loudly on missing invariants** (ALWAYS rule 10) — a *silently*
   degraded Watcher is worse than an absent one, so degradation must be
   visible in `/api/v1/watcher/health` even while it stays non-blocking.

---

## 3. Architecture — three parts, one loop

```
                    ┌──────────────────────────────────────────────┐
                    │  1. OBSERVE                                  │
  oasis_events ────►│  watcher-observer.ts                         │
  dev_autopilot_    │  normalizes every lifecycle step into one    │
    executions  ───►│  timeline row per (work_unit, step)          │
  worker/orch.  ───►│                                              │
  GitHub PR/CI  ───►│  → watcher_steps                             │
                    └───────────────────┬──────────────────────────┘
                                        │
                    ┌───────────────────▼──────────────────────────┐
                    │  2. REMEMBER                                 │
                    │  watcher-distiller.ts                        │
                    │  step + outcome → durable lesson             │
                    │  · auto-derived pattern_key (existing style) │
                    │  · LLM distillation for narrative failures   │
                    │  · dedupe/merge, frequency, decay            │
                    │                                              │
                    │  → watcher_lessons   (learned, evidence-based)│
                    │  → watcher_rules     (authored invariants)   │
                    └───────────────────┬──────────────────────────┘
                                        │
                    ┌───────────────────▼──────────────────────────┐
                    │  3. REMIND                                   │
                    │  watcher-reminder.ts                         │
                    │  GET /api/v1/watcher/remind?context=...      │
                    │  ranked, budgeted, ≤6 items / ≤800 tokens    │
                    └───────────────────┬──────────────────────────┘
                                        │
          ┌─────────────────────────────┼─────────────────────────────┐
          ▼                ▼            ▼             ▼               ▼
    planner prompt   executor      worker-runner   pre-merge /    Command Hub
    (dev-autopilot-  prompt        execution-      pre-deploy     "what does the
     planning.ts)    (dev-autopilot service.ts     gate           watcher know?"
                      -execute.ts)  (VTID-01200)   (advisory)     panel
                                        │
                                        ▼
                              outcome recorded ──────► back to 1. OBSERVE
                              (was the reminder used? did it help?)
```

The **feedback edge is the whole point.** A reminder store with no
relevance signal degrades into noise within weeks, and a worker that
learns to skim past the reminder block is worse than one that never had it.

### 3.1 Data model

Three new tables. Snake_case, RLS enabled, service-role-only writer —
matching `dev_autopilot_prompt_learnings`' existing posture.

**`watcher_steps`** — the timeline. One row per observed lifecycle step.

| Column | Notes |
|---|---|
| `id` | uuid pk |
| `work_unit_kind` | `'vtid' \| 'execution' \| 'pr' \| 'session'` |
| `work_unit_id` | VTID string, execution uuid, PR number, or session id |
| `vtid` | denormalized for the common join |
| `step` | `'allocated','planned','queued','running','validated','pr_opened','ci','merged','deploying','verified','completed','failed','reverted','escalated','doc_updated'` |
| `outcome` | `'success' \| 'failure' \| 'skipped' \| 'unknown'` |
| `actor` | `'autopilot' \| 'worker-runner' \| 'claude-session' \| 'human' \| 'ci'` |
| `evidence` | jsonb — event ids, PR url, error excerpt, commit sha |
| `observed_at`, `source` | provenance |

Indexed on `(work_unit_id, observed_at)` and `(step, observed_at DESC)`.

**`watcher_lessons`** — the learned memory. A strict superset of
`dev_autopilot_prompt_learnings`; that table is **migrated in, then
retired** (see §4, Phase 2) rather than left as a second source of truth.

| Column | Notes |
|---|---|
| `id` | uuid pk |
| `stage` | which lifecycle step the lesson applies to — the axis the old table lacked |
| `pattern_type` | superset of the old CHECK list, plus `ci_failure`, `deploy_failure`, `verification_failure`, `governance_violation`, `review_rejection` |
| `pattern_key` | normalized signature, e.g. `TS2307:cannot-find-module` |
| `scope` | jsonb — `{scanner?, service?, path_glob?, repo?}`. Replaces the old single `scanner` column and lets a lesson target the worker-runner, which has no scanner |
| `lesson` | the actual reminder text, imperative, ≤200 chars |
| `evidence_step_ids` | uuid[] → `watcher_steps` |
| `frequency`, `first_seen_at`, `last_seen_at` | decay inputs |
| `confidence` | 0–1, raised by recurrence, lowered by unhelpful feedback |
| `status` | `'active' \| 'muted' \| 'graduated'` — graduated = promoted into `CLAUDE.md`/a lint rule, so stop spending prompt budget on it |
| `mitigation_note` | human-authored upgrade (kept from the old table) |

**`watcher_rules`** — authored invariants, not learned ones. This is where
`CLAUDE.md`'s ALWAYS/NEVER/IF-THEN rules become machine-retrievable.

| Column | Notes |
|---|---|
| `rule_key` | e.g. `staging_first.no_exec_deploy_to_prod` |
| `source_ref` | `CLAUDE.md §16` — so a reminder can cite its authority |
| `trigger` | jsonb — declarative match on step/scope/diff-path, e.g. `{step:'deploying', touches:['.github/workflows/**']}` |
| `reminder` | the text to inject |
| `severity` | `'info' \| 'warn' \| 'block_candidate'` |
| `enabled` | bool |

Adding a rule is a row, not a code change — same ergonomic property that
makes `awareness-watchdogs.ts` pleasant ("adding a watchdog is a
typed-array entry, no schema change").

### 3.2 Retrieval and budget

`GET /api/v1/watcher/remind` takes a context descriptor
(`{stage, vtid?, scanner?, service?, touched_paths?, actor}`) and returns a
ranked block:

```
score = 0.45·stage_match + 0.25·scope_match + 0.15·recency_decay
      + 0.10·frequency_log + 0.05·severity
```

Hard budget: **≤6 reminders, ≤800 tokens, rules before lessons**, ordered
most-severe-first. The budget is not a nicety — an unbounded "lessons"
block is how prompt sections get ignored. Anything cut is reported in the
response's `truncated` field so the Command Hub can show what was dropped
(no silent caps).

Response shape follows §10: `{ ok, data: { reminders: [...], truncated } }`.

### 3.3 Injection points

| Consumer | File | Change |
|---|---|---|
| Planner | `dev-autopilot-planning.ts:314` | Already reads learnings by scanner — swap for `/remind?stage=planning` |
| Executor | `dev-autopilot-execute.ts:298` (`loadExecutionLessons`) | Same swap, `stage=execute` |
| **Worker-runner** | `services/worker-runner/src/services/execution-service.ts` | **New.** Fetch reminders via `gateway-client.ts` before building the LLM call. This is the "support the worker and runner" half of the ask, and it has no memory at all today |
| Pre-merge / pre-deploy | `dev-autopilot-watcher.ts` | Evaluate `watcher_rules` with `severity='block_candidate'`; **advisory in v1** — log + emit a `vtid.decision.watcher.reminded` event, do not block. See open question Q2 |
| Claude Code sessions | `SessionStart` hook → `/remind?actor=claude-session` | Optional, Phase 5. This is what would have caught VTID-03419's unpushed doc step |

### 3.4 Feedback

Every reminder returned carries a `reminder_id`. When the consuming step
reaches a terminal outcome, `POST /api/v1/watcher/feedback` records
`{reminder_id, work_unit_id, outcome, repeated_mistake: bool}`.

- Reminder shown **and** the mistake still happened → confidence down; the
  lesson text is probably too vague. Flag for rewrite.
- Reminder shown, mistake absent, and it recurred before the reminder
  existed → confidence up.
- Reminder shown 20× with no correlated mistake either way → `muted`. It's
  costing prompt budget for nothing.

---

## 4. Phasing

Each phase is independently shippable and independently useful. Each gets
its **own** VTID at start (per §4.1 — one VTID per distinct piece of work);
VTID-03454 covers this plan document only.

### Phase 1 — Observe (no behavior change)
- `watcher_steps` table + migration + `DATABASE_SCHEMA.md` update.
- `watcher-observer.ts`: one 60 s tick reading `oasis_events` +
  `dev_autopilot_executions` deltas since a stored cursor. Writes timeline
  rows. Emits **no** OASIS events.
- `GET /api/v1/watcher/timeline?vtid=` + `/api/v1/watcher/health`.
- **Exit criteria:** for the last 20 executions, the timeline reconstructs
  the lifecycle with no gaps, cross-checked against `dev_autopilot_executions`.
- Risk: low. Read-only + one new table. Nothing consumes it yet.

### Phase 2 — Remember
- `watcher_lessons` + `watcher_rules` tables.
- Backfill: migrate every `dev_autopilot_prompt_learnings` row into
  `watcher_lessons` (`stage='execute'`, `scope={scanner}`), then point
  `dev-autopilot-execute.ts`/`-planning.ts` at the new table and **drop the
  old one in the same PR**. Two learning stores is how they drift apart.
- `watcher-distiller.ts`: rule-based `pattern_key` derivation first (reuse
  the existing tsc/jest/parse normalizers verbatim), LLM distillation only
  for narrative failures (CI logs, review comments). Per §26–28 of the
  IF-THEN rules, validation-class work routes to Claude.
- Seed `watcher_rules` from `CLAUDE.md`: staging-first (§16), deployment
  verification (§15), VTID allocation (§4.1), i18n hard rule (vitana-v1
  `CLAUDE.md`), AWS/GCP split (§1b), `no gcr.io`, `/alive` not `/healthz`.
  ~20 rules to start.
- **Exit criteria:** replaying the last 60 days of failures produces
  lessons whose top-5-by-score, for each of 10 sampled failures, contains
  the one a human reviewer says would have prevented it.

### Phase 3 — Remind (autopilot only)
- `watcher-reminder.ts`, `/remind`, `/feedback`.
- Wire planner + executor. **Behind `WATCHER_REMINDERS_ENABLED`** (default
  off) so it ships dark, per the `BEDROCK_ROLE_ARN` precedent — and note
  the `FEATURE_ORB_FAST_START_ENV` trap: *setting the var is not the same
  as the feature resolving live in that environment*. `/api/v1/watcher/health`
  must report the **resolved** value, not the raw env var.
- **Exit criteria:** on staging, ≥10 executions run with reminders on;
  repeat-mistake rate for previously-seen `pattern_key`s drops measurably
  vs. the prior 10 with it off. If it doesn't move, the lessons are too
  vague — fix Phase 2 before proceeding.

### Phase 4 — Remind (worker-runner) + Command Hub surface
- Extend `worker-runner/src/services/gateway-client.ts` with `fetchReminders()`;
  inject in `execution-service.ts`. This is the piece the user's ask names
  explicitly and the piece that has no memory today.
- Command Hub panel: timeline per VTID, active lessons, rules, mute/graduate
  controls, feedback stats. Static assets only, CSP-safe, `?v=` bumped.
- **Exit criteria:** worker-runner executions show reminders in their
  recorded prompt; a muted lesson stops appearing within one tick.

### Phase 5 — Sessions (optional, needs Q1 answered)
- `SessionStart` hook posts session context; `/remind?actor=claude-session`
  returns the governance rules relevant to the files about to be touched.
- Session-end reconciliation: "you changed `docs/` but never pushed",
  "you deployed but never ran the §15 post-deploy curl" — exactly the
  VTID-03419 and ORB-FASTSTART failure modes.

---

## 5. What this deliberately does **not** do

- **Does not block anything in v1.** Severity `block_candidate` only logs.
  Turning a reminder into a gate is a separate, later decision (Q2).
- **Does not become a new deployable service.** Gateway module only.
- **Does not replace self-healing.** Self-healing reacts to *this* failure;
  the Watcher remembers across failures. They compose: a self-heal
  triage is a high-value distillation input.
- **Does not touch user-facing memory** (`memory_items` / `memory_facts` /
  Memory Garden). That is per-user product memory with RLS and tenant
  scoping. This is engineering-plane memory. Mixing them would violate
  tenant isolation for zero benefit.
- **Does not watch production runtime health.** That is CloudWatch alarms +
  `awareness-watchdogs` + the verification window. The Watcher watches the
  *development process*.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| **Reminder fatigue** — worker learns to skim the block | Hard budget (≤6/≤800 tok), feedback-driven auto-mute, `graduated` status retires lessons into lint rules/`CLAUDE.md` |
| **Wrong lessons learned** — a one-off flake becomes permanent doctrine | `confidence` requires recurrence; `frequency=1` lessons are excluded from injection for 7 days; human mute/edit in Command Hub |
| **Watcher outage stalls executions** | Every read is best-effort try/catch → `[]`, mirroring `loadExecutionLessons`. Degradation visible in `/health` |
| **Tick loop pollutes OASIS** | Explicit: observer emits zero events. Only `vtid.decision.watcher.*` on an actual reminder-raised decision |
| **Two learning stores drift** | Phase 2 drops `dev_autopilot_prompt_learnings` in the same PR that migrates it |
| **Distiller LLM cost** | Rule-based derivation handles the common cases; LLM only on narrative failures, rate-capped per day |
| **Scope creep into an autonomous fixer** | Charter: observe + remember + remind. Any "and then it fixes it" belongs to self-healing, which already exists |

---

## 7. Open questions

These change what gets built. My recommended default is listed first for
each, and Phases 1–3 can proceed on the defaults without being blocked.

**Q1 — Scope: what does it watch?**
- *(recommended)* Autopilot + worker-runner first; Claude Code sessions in
  Phase 5. Gets value fastest, keeps the observer surface small.
- Or: sessions from day one — this is what would have caught the
  VTID-03419 lost-doc-step and is where *most* real development happens
  right now. Costs a hook + a session-identity model up front.

**Q2 — Authority: remind, or block?**
- *(recommended)* Advisory in v1. A blocking watcher that is wrong once
  gets disabled forever.
- Or: hard-gate the small set of rules with an unambiguous machine check
  (e.g. "push to `main` at/after cutover must not dispatch EXEC-DEPLOY to
  prod"). Higher value, but it is a governance gate and deserves its own
  approval.

**Q3 — Memory seeding.**
- *(recommended)* Both: auto-derive from history **and** seed ~20 authored
  rules from `CLAUDE.md`. Authored rules give value on day one before any
  history has accumulated.
- Or: learned-only, to avoid `CLAUDE.md` and `watcher_rules` drifting apart.

**Q4 — Does the Watcher get its own voice?** Should it be able to *speak*
(ORB / Command Hub notification: "you're about to repeat VTID-03446") or is
it prompt-injection only? Default: prompt-injection + Command Hub panel;
no proactive notifications in v1.

---

## 8. Verification plan

Per §15 and the Targeted Visual Verification protocol:

- Each phase: `npm run build` in `services/gateway`, unit tests for the
  distiller's `pattern_key` normalizers and the reminder ranker/budget.
- Timeline correctness cross-checked against `dev_autopilot_executions`
  for 20 real executions before anything consumes it.
- Phase 3/4 measured on **staging** (`preview-gateway.vitanaland.com`,
  `env=staging`) — reminders reach production only via PUBLISH, per §16.
- Command Hub panel (Phase 4): screenshot desktop 1400×900 + mobile
  390×844, interact with mute/graduate, inspect the screenshots before
  reporting done.
- `DATABASE_SCHEMA.md` updated in the same PR as each migration (ALWAYS
  rule 24).
