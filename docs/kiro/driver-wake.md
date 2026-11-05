# Driver wake (VTID-05354, plan `pipeline-agent-wake-and-review`)

**Why.** Measured over 31 sparred plans (2026-10-13 → 10-27): a CI sparring round takes p50 4 min, but the
planner's answer to it took p50 5 min / **p90 3.4 h**, and convergence → plan merged p50 41 min / **p90 19.6 h**.
The delay is a driver that is not running: the seat automations wake at most hourly.

**What.** `.github/workflows/DRIVER-WAKE.yml` runs when PLAN-SPAR completes (success or failure) on a `plan(<slug>)`
PR, when a review verdict (`Collab-Verdict:` trailer) is pushed to a `kiro/<slug>/…` lane file, or by manual
dispatch. `scripts/collab/driver-wake.mjs` decides, in this order:

| Condition | Result |
|---|---|
| no valid slug / not a plan event / fork | skip |
| repository secret `KIRO_API_KEY` not set | skip, summary `wake unavailable: KIRO_API_KEY not configured` |
| `collab-driver/<slug>` heartbeat younger than 45 min | skip (`driver alive`) |
| `collab-wake/<slug>` marker younger than 20 min | skip (`woken recently`) |
| 6 or more markers in the last hour, repo-wide | skip (`wake budget`) |
| otherwise | write the marker, start **one** Kiro cloud session with the fixed prompt below |

Markers older than 2 h are deleted on every run. The prompt is a fixed sentence plus the validated slug. The job
checks out `main`, never the pushed branch. A woken session never merges, publishes or writes a live system.

The instructions live here, not in `.kiro/automations/` (that folder holds one automation file per seat and
`automations.test.mjs` pins it).

## Turn it on (owner or administrator)
1. In the Kiro portal (app.kiro.dev), with a Pro, Pro+, Pro Max or Power seat, create an API key
   (kiro.dev/docs/cli/headless, "Authentication").
2. GitHub → `exafyltd/vitana-platform` → Settings → Secrets and variables → Actions → New repository secret
   `KIRO_API_KEY`.
3. Check: Actions → DRIVER-WAKE → Run workflow with a real plan slug and `dry_run: true`. The summary says
   `would wake` (no live driver) or `skip (driver alive)`.

## Turn it off
Delete the secret (every run becomes a green no-op) or disable the workflow.

## Cost
At most one cloud session per plan per 20 min and 6 per hour repo-wide; none while a driver is alive.

## For the woken session
Your prompt was: *Read docs/kiro/driver-wake.md in vitana-platform, section "For the woken session", and follow it
for plan `<slug>`.*

A sparring round or a review verdict for plan `<slug>` has arrived and the plan had no live driver. You are an
**automation-started driver** for that one plan (`.kiro/pipeline/driver.md`, section "Automation-started driver").

1. Locate both checkouts (`git -C <dir> remote get-url origin`) and load the project rules
   (`.kiro/steering/vitana-load-project-rules.md` and everything it lists). They are binding.
2. Session id: `node scripts/collab/queue.mjs session-id --agent kiro --seat <the plan's author_seat>`.
3. If `refs/heads/collab-driver/<slug>` is younger than 45 min, another driver woke first: stop at once.
4. Follow `.kiro/pipeline/driver.md` **Resume** and **Loop** for plan `<slug>` only, with these limits:
   - answer an open sparring round; run reviews with the reviewer agent; re-run a PLAN-SPAR run that failed for
     infrastructure once per head (`collaboration.md` §7a allowlist);
   - **never merge, never publish, never dispatch a production workflow, never apply a migration, never write a
     live system**; landing stays with the Project Manager or an interactive driver;
   - do not build a governance lane or an `executor: claude` lane.
5. Stop when nothing is left to do now (checks running, review pending), after the last heartbeat, with everything
   pushed and the claims you no longer need released.

This section does not change `driver.md`; where they differ, `driver.md` and the rule files win.
