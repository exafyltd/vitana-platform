# Loop Engineering — how Vitanaland heals and improves itself

VTID-05084 (Phase 1). Owner direction 2026-10-12: make Vitanaland a
self-improving system based on loop engineering, and keep it simple —
*"we should always simplify our system and not overcomplicate."*

- **Catalog (source of truth):** `services/gateway/specs/loop-catalog-v1.json`
- **API:** `GET /api/v1/autonomy/loops` (exafy_admin, read-only)
- **Screen:** Command Hub → Autonomy → **Loops** (`/command-hub/autonomy/loops/`)
- **Guard:** `services/gateway/test/loop-catalog.test.ts`
- **Plan and sparring record:** `docs/validation/VTID-05084/plan-sparring.md`

## 1. The rule: a check is not a loop

Loop engineering means designing the system *around* an agent — its goal,
tools, memory, verification, retries, cost limits and stop conditions — so it
can make progress without a human prompting every step.

Vitanaland already had hundreds of checks (tests, health checks, routines,
alert workflows). A check only says green or red. On its own it improves
nothing; most of it alerted and stopped there. So we use three layers:

| Layer | What it is | Rule |
|---|---|---|
| **Sensors** | Tests, health checks, routines, alert workflows | Stay in the registries they already live in. Never re-listed as loops. **Every sensor is owned by exactly one loop, or is marked to retire.** |
| **Loops (14)** | A closed cycle: sense → decide → act → **verify with the same sensor** → learn | Few loops. A new problem becomes a new *case* in an existing loop, not a new loop. |
| **Shared engine** | One intake, one executor, one run ledger, one human inbox, shared verifiers | No loop builds its own copy of any of these. |

## 2. The loop contract

A loop is valid only when all eight are written down (the catalog test fails
otherwise):

| Field | Meaning |
|---|---|
| `trigger` | What starts a run (event, schedule, threshold) |
| `goal` | A finish line someone outside the loop can check — a number or a pass/fail, never "make X better" |
| `act` | The tools the loop may use |
| `verifier` | An independent check. The agent that did the work never grades it |
| `stop` | When it is done, and when it gives up (the same failure N times, or no progress → stop and escalate) |
| `human_gate` | Which actions need a person |
| `budget` | Maximum attempts, spend or time per run |
| `metrics` | What shows the loop actually improves the system |

**Risk** — R0 internal read · R1 internal, reversible · R2 member-visible or
money · R3 health, payments, legal, personal data.
**Autonomy** — L0 observe · L1 recommend · L2 prepare for approval · L3 act
within limits.

Invariants enforced by the test:
- R2 and R3 loops always have a human gate.
- R3 loops never go above L2.
- Any loop that writes health, product or creator text uses the shared
  **claim verifier** (no diagnosis or treatment claims).
- The health loop also uses the **red-flag rules** (urgent-care escalation).
- No loop routes an LLM stage to Google (CLAUDE.md 10a–10c, IF-THEN 27).
- No loop writes community content as a test account (CLAUDE.md rules 31, 43).

## 3. The 14 loops

| # | Loop | Status today | Cycle in one line |
|---|---|---|---|
| L1 | Repair | Partial | Any owned sensor red → self-healing intake → fix via the executor → re-run the same sensor + STAGING-VERIFY |
| L2 | Build & Release | Live | Finding → PR → review → merge → staging → STAGING-VERIFY → Gate 2 → production check |
| L3 | Learn | Partial | Every outcome leaves one lesson: a test, a repair pattern, a prompt learning, or a graduation proposal |
| L4 | Simplify | Planned | Duplicate, orphan or dead thing → removal proposal → verify coverage unchanged |
| L5 | Guard | Partial | Cost, model fallback, secrets, test accounts, consent, ledger integrity → escalate only |
| L6 | Support | Live | Ticket → spec or answer → fix → reporter notified |
| L7 | Voice quality | Partial | Session outcomes → tuning → shadow → enforce |
| L8 | Content & language | Partial | New string or feature → 11 locales → audit → What's New |
| L9 | Supplier catalog | Partial | Supplier/feed → deterministic validation → claim/media/certificate checks → approval → publish → keep in sync |
| L10 | Listing & creator commerce | Planned | Listing or video → audit, product match, variants under the claim verifier → approval → measure |
| L11 | Trust | Planned | Review or report → classify → hold → human decides |
| L12 | Engagement | Partial | Notification outcomes → cadence proposal → human approves |
| L13 | Community matching | Partial | Matches, events, recommendations → acceptance → weights |
| L14 | Health coaching (R3) | Partial | Check-in → non-diagnostic plan → prepared action → member confirms → adherence |

**Shared engine:** intake `self_healing_log` (+ `autopilot_recommendations`),
executor Dev Autopilot, run ledger `agent_runs_unified`, human inbox Autonomy
Pulse, and two shared verifiers (claim verifier, red-flag rules; both planned).

The 100 loop ideas from the first draft of this plan are not lost: each one
is a **case** inside exactly one loop (or one of the shared verifiers). The
catalog stores each case's original id and title, and the test checks all
100 are present once.

## 4. The coverage rule — how the system stays small

Each loop names the sensors it owns, by reference to the registries that
already exist. Nothing is copied:

| Sensor kind | Registry |
|---|---|
| `health_groups` | `SERVICE_HEALTH_GROUPS` in `services/gateway/src/constants/service-health-registry.ts` |
| `routines` | `routines/*.md` at the repo root (README files excluded) |
| `workflows` | `.github/workflows/*.yml` that have a `schedule:` |
| `test_contracts` | `COMMAND_ALLOWLIST` keys in `services/gateway/src/services/test-contract-commands.ts` |

`test/loop-catalog.test.ts` reads all four and fails when a sensor:
- belongs to no loop (an orphan nobody acts on),
- belongs to two loops, or
- is named in the catalog but no longer exists.

So **adding a routine, a health group, a scheduled workflow or a test contract
means saying which loop acts on it** — or listing it in `retire_candidates`
with a reason. The gateway image does not contain `routines/` or
`.github/`, so at runtime the API checks the two compiled-in registries live,
and CI enforces the other two.

## 5. Known overlaps (the Simplify loop's first backlog)

Found while comparing the plan with Testing & QA, Routines and Health Checks
(2026-10-12). Phase 2 (VTID-05098) worked through them; the catalog carries
each one's `status` and `resolution`, and the Loops screen shows them.

| # | Overlap | Outcome (VTID-05098) |
|---|---|---|
| O1 | Two Health Checks tabs with the same 5 probes | **Resolved.** Infrastructure → Health removed and redirected; Diagnostics → Health Checks unchanged. |
| O2 | ORB health in 4 places | **Partly resolved.** Routine `orb-audio-smoke` retired. The widget E2E and bootstrap-latency checks are distinct and stay; the session-state alert vs panel pair is Phase 3. |
| O3 | Push pipeline in 3 places | **Partly resolved.** Routine `push-pipeline-probe` and its audit endpoint retired; pointing the alert workflow at `/ops/health/push-dispatch` is Phase 3. |
| O4 | Migration drift twice | **Resolved.** Routine `migration-backlog` and its audit endpoint retired; MIGRATION-DRIFT-CHECK stays. |
| O5 | Frontend reachability twice | **Resolved.** Routine `cloud-run-frontend-health` retired; the registry checks stay. |
| O6 | Self-healing queue actionable on 2 screens | **Resolved.** Pulse links to Autonomy → Self-Healing (its apply/discard sent `{vtid}` and always failed). |
| O7 | Test-contract failures actionable on 2 screens | **Resolved.** Pulse links to Testing & QA → Test Contracts (its rerun/open had no handler). |
| O8 | `self-healing-triage` registered twice | **Resolved.** Not the same thing: the inert routine is retired, the triage agent stays. |
| O9 | Missing-test scanner twice | **Not a duplicate.** Two live paths with different signals. |
| O10 | Scheduled jobs listed in 4 places | **Not a duplicate.** Four scopes, one generated; deriving `SCHEDULED_WORKFLOWS` is Phase 3. |

**Found on the way (2026-10-12):** every routine had two live claude.ai
triggers — an April generation posting to the deleted Cloud Run gateway
(reporting "succeeded" because the script exits 0) and a September generation
that fails on every run. The retired routines' September triggers are disabled;
the April-generation triggers were created through the HTTP API and can only
be disabled by the owner (list in `docs/validation/VTID-05098/acceptance.md`).
The routine ingest token sits in plain text in the trigger prompts and should
be rotated.

## 6. Roadmap (each step has its own plan, sparring and VTID)

1. **Phase 2 — Simplify first (VTID-05098, done).** Retired five dead or duplicate routines, one Health tab, one place to act in Pulse; outcomes in §5.
2. **Phase 3a — Close L1 (VTID-05103).** Why the routines failed: every claude.ai routine session ran the cloud environment's setup script, which `cd`s into `vitana-platform/services/gateway`; routine sessions clone no repo, so the script exited 1 before the prompt ran. Nine routines were only "curl an audit endpoint + a threshold", so they now run inside the gateway (`services/routine-runner`, once per UTC day, exactly once across tasks via `claim_routine_run`, results in the same `routine_runs` tables, breaches into the one self-healing intake; off on staging, pinned on in production). The seven `ALERT-*` workflows report a failure to `/api/v1/self-healing/report`. `voice-lab-triage` is not run: its spec reads data the route does not return.
3. **Phase 3b — the rest of L1 and the guard rails (VTID-05141).** `voice-lab-triage` runs in the gateway on `voice_session_facts` (real 24 h vs 7-day windows, failure classes). Every ALERT-* workflow check has one gateway ops health route (`/api/v1/ops/health/*`); the workflows call the production route instead of their own query (Step A: ledger, ORB session, push; Step B after production: welcome greeting, ORB bootstrap latency, new-day briefing). The Supabase-vs-Aurora identity drift alert stays a workflow (the gateway has no Aurora access). `SCHEDULED_WORKFLOWS` is derived from the generated test catalog. Stop rules: `agents_registry.enabled` is enforced (delegation and community autopilot refuse a switched-off agent); three crashed runs in a row switch a routine off (`routine.runner.stagnated`); the same breach three days running is not re-sent to self-healing. L5: `llm-spend-budget` (daily, alert only) and `llm-fallback-watch` (any Google landing is an incident). Still the **owner's**: the environment setup script (`[ -d vitana-platform/services/gateway ] && cd …`) so the four session routines run again, the April-generation triggers, the routine token rotation.
4. **Phase 4 — L3 Learn (VTID-05148).** The gateway routine `learn-outcomes` (daily 12:00 UTC, `routines/learn-outcomes.md`) acts on the outcomes ledger. An escaped bug becomes a test: every fix in `self_healing_log` gets `diagnosis.tests_added` from its own PR's changed files (GitHub PR files API, at most 50 PRs per run, read-modify-write of the whole `diagnosis`; a GitHub error leaves the row for the next run), and a fix whose PR shipped no test becomes one `write_test` finding through the missing-test insert, deduped by fix VTID + endpoint. Graduations are proposed, never applied: on Mondays a `(scanner_name, risk_class)` class with ≥ 20 executions in 30 days, ≥ 95 % success, no rollback, no human-edited plan and not already eligible gets `learn.graduation.proposed`; an open proposal whose class drops below 90 % or gets a rollback gets `learn.graduation.withdrawn`. Open proposals show in Autonomy Pulse (`graduation_proposal`, read-only). The three L3 metrics (repeat-failure rate per class, pattern reuse — `not_measured` until an execution records a repair pattern, escaped bugs → tests with older rows `unknown`) are stored in the run's findings and shown on the L3 card; a class above 30 % with ≥ 5 fixes raises `learn.repeat_failure.high`. No code changes `auto_exec_eligible` or an autonomy level. Still recorded only: repair-pattern auto-record (PR-L5.1), prompt-learning and shadow-eval graduation.
5. **Phase 5 — L9 Supplier catalog, wave 1 (VTID-05153).** The gateway routine `supplier-catalog-check` (daily 13:00 UTC, `routines/supplier-catalog-check.md`) checks at most 20 supplier rows (`source_network = supplier_referral`) of one category (`supplements`) per run, in organizations that are not rejected and without test or service accounts. Deterministic only, no LLM: lossless normalization then `ProductSchema`; required fields and money (`isCompleteOffering`, price > 0 for a product, ISO 4217, compare-at ≥ price, one image); duplicates within the supplier (gtin/sku, canonical URL, normalized title); an SSRF-guarded HEAD probe of up to 3 images (an egress outage records `image_unchecked`, no strike); a short EN/DE disease-claim pre-screen whose hit only routes the row to human review (`needs_review`; verified claims are Phase 6). One result per row in the reserved key `products.attributes.catalog_check` (codes + params, never text; suppliers cannot set it), written only when the row is unchanged since the read; the routine never inserts, never writes `is_active`/`merchant_id`, never publishes. The same failure three times on unchanged content returns the row to the supplier: the checklist's catalogue step names `catalogue_fixes` (status unchanged), MCP `next_action` points at `update_product`. Metrics in the run's findings and on the L9 card: ready-for-approval share against the 0.80 target, validation failure rate, rows auto-normalized; time to listing and human edits per listing are `not_measured`. Not yet: certificate expiry (needs the evidence tables), sync drift, reorder drafts, WooCommerce feed import, the vitana-v1 rendering of `catalogue_fixes`.
6. **Phase 6 — Shared safety verifiers, then L14.** Claim verifier and red-flag rules with eval sets first; the health coaching MVP after.

## 7. Changing the catalog

- **Add a case:** append it to the loop that acts on it. Do not add a loop.
- **Add a loop:** only when no existing loop's cycle fits. It needs a plan, sparring and a VTID like any other change.
- **Change a status** (Planned → Partial → Live): only when the code that closes that step has shipped; `existing_ref` must point at it.
