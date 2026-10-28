# Responses to sparring session 2, round 1

Session `747f12ec-e8df-4e28-ad15-1d2b781fa355`.

All four findings are **accepted** — the partner found two genuinely wrong premises in the inventory
(both verified against `origin/main`) plus two description refinements. None is a product-behaviour
change; all are corrections to premises and lane structure.

- **R1-F1 (major, accepted).** Verified on `origin/main`: `VCAOP-GUARDRAILS-CI.yml` runs
  `npm run typecheck` (:39), `npm run test:guardrails` as the required gate (:42) and `npm test` (:45) on
  the same `services/vcaop/**` `pull_request`/`push` triggers. So `VCAOP-CICD.yml` is **not** the only
  runner of the vcaop typecheck/guardrails gates — its only unique body is the dead GCP `deploy-dev` job,
  and deleting it loses no gate. The earlier draft missed `VCAOP-GUARDRAILS-CI.yml`. Fix: lane 1 is now
  **independent** (deletes `VCAOP-CICD.yml`, cites `VCAOP-GUARDRAILS-CI.yml` in its evidence row, no
  migration); lane 6's vcaop-matrix migration (option A conditional steps) is **removed**; the lane-1→6
  `depends_on` is dropped; the Today section, the Parallel/dependency section, and both lanes' tasks +
  acceptance are corrected.

- **R1-F2 (minor, accepted).** Verified on `origin/main`: `TEST-SUITE.yml:43-70` has
  `strategy.matrix.shard: [1,2,3,4]`, job name `Gateway (Jest, shard N/4)`, step
  `npx jest … --maxWorkers=100% --shard=${{ matrix.shard }}/4`. The gateway suite is a **4-shard matrix**,
  not one job — the brief's "4 shards" was correct and the earlier draft's "one job" was wrong. Fix: the
  Today section, the ground-truth-counts note, the measurement section and lane 6 (T3 + acceptance) now
  state the 4-shard matrix and frame re-balancing as rebalancing those four shards on the real gateway
  count.

- **R1-F3 (minor, accepted).** Once R1-F1 removes the migration, the `--runInBand` rationale is moot: the
  new run-in-band guardrails step no longer exists. The guardrails suite already runs under parallel
  `npm test` in `VCAOP-GUARDRAILS-CI.yml`, (formerly) `VCAOP-CICD.yml`, and TEST-SUITE's vcaop entry, so
  there is no evidence it fails under parallel workers — and no need to assert it. The `--runInBand`
  claim is dropped from the plan along with the migration. (If a real parallel-worker failure ever
  surfaces, that is a ci-health finding, not a reason to re-add the step.)

- **R1-F4 (minor, accepted).** Verified on `origin/main`: `queue.mjs:452` already excludes `pm-agent`
  from the per-lane session count (`if (k.lane && k.session !== PM_AGENT)`), so only the `ci-plan-spar`
  literal trips the "one session per lane" rule on a `_plan` lane. Lane 3's bug description (plan bullet
  and tasks T2) is narrowed to `ci-plan-spar` only, with a note not to re-implement the pm-agent
  exclusion and to prove the fix with a red-on-base test first.

No finding was rejected or deferred.

```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "Verified on origin/main: VCAOP-GUARDRAILS-CI.yml runs npm run typecheck (:39), npm run test:guardrails as the required gate (:42) and npm test (:45) on the same services/vcaop/** triggers. VCAOP-CICD.yml's only unique body is the dead GCP deploy-dev job, so deleting it loses no gate. Removed lane 6's vcaop-matrix migration and the lane-1 depends_on; lane 1 is now independent and cites VCAOP-GUARDRAILS-CI.yml in its evidence row. Corrected the Today, Parallel/dependency and lane 1/6 task+acceptance sections."},
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "Verified on origin/main: TEST-SUITE.yml:43-70 runs the gateway suite as a 4-shard matrix (strategy.matrix.shard: [1,2,3,4], npx jest --maxWorkers=100% --shard=N/4, job name Gateway (Jest, shard N/4)). The brief's 4 shards was correct; the draft's one job was wrong. Corrected the Today section, ground-truth note, measurement section and lane 6 T3+acceptance to the 4-shard reality."},
  {"finding_id": "R1-F3", "disposition": "accepted", "rationale": "With R1-F1 removing the migration, the run-in-band guardrails step no longer exists, so the --runInBand rationale is moot and dropped. Guardrails already runs under parallel npm test in VCAOP-GUARDRAILS-CI.yml and TEST-SUITE's vcaop entry with no evidence of parallel-worker failure; no new step and no assertion needed."},
  {"finding_id": "R1-F4", "disposition": "accepted", "rationale": "Verified on origin/main: queue.mjs:452 already excludes pm-agent (if (k.lane && k.session !== PM_AGENT)); only ci-plan-spar trips the one-session-per-lane rule on a _plan lane. Narrowed lane 3's bug description (plan bullet + tasks T2) to ci-plan-spar only, with a note not to re-implement the pm-agent exclusion and to prove with a red-on-base test first."}
]
```
