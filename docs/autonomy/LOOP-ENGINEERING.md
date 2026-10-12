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
(2026-10-12). Phase 1 only lists them; removing each one is its own change.

1. Two Health Checks tabs (`diagnostics/health-checks`, `infrastructure/health`) show the same 5 probes; neither uses the 117-check Service Health registry.
2. Voice assistant (ORB) health is checked in 4 places.
3. The push pipeline is checked in 3 places.
4. Migration drift is checked twice.
5. Frontend reachability is checked twice.
6. The self-healing queue is actionable on 2 screens.
7. Test-contract failures are actionable on 2 screens.
8. `self-healing-triage` is registered twice (routine and agent).
9. The missing-test scanner is registered twice.
10. Scheduled jobs are listed in 4 places.

## 6. Roadmap (each step has its own plan, sparring and VTID)

1. **Phase 2 — Simplify first.** Remove the overlaps above: one health view on the registry, one probe per concern, one place to act, one scheduled-job list.
2. **Phase 3 — Close L1 and add guard rails.** Alert workflows write to the one intake; per-loop kill switch, budget and stagnation stop on the existing `agents_registry` + `agent_runs`; L5 spend budgets and the silent-fallback incident rule.
3. **Phase 4 — L3 Learn.** Act on the outcomes ledger (graduation proposals; an escaped bug becomes a test).
4. **Phase 5 — L9 Supplier catalog, wave 1.** One category, at most 20 SKUs per run, deterministic validators before any LLM, human publish gate. Target: 80% of rows ready for approval without manual entry.
5. **Phase 6 — Shared safety verifiers, then L14.** Claim verifier and red-flag rules with eval sets first; the health coaching MVP after.

## 7. Changing the catalog

- **Add a case:** append it to the loop that acts on it. Do not add a loop.
- **Add a loop:** only when no existing loop's cycle fits. It needs a plan, sparring and a VTID like any other change.
- **Change a status** (Planned → Partial → Live): only when the code that closes that step has shipped; `existing_ref` must point at it.
