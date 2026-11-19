# Tasks — delivery-loop-engine

Code starts only after the VTID is allocated (blocked: `registration-blocked.md`). The code of every lane already exists on the
integration branch `kiro/delivery-loop-engine/gitlab-executor` with its tests; once VTIDs exist each lane is cut from it into its own
branch `kiro/delivery-loop-engine/<lane>` from `origin/main`, with its tests recorded red on `origin/main` in
`docs/validation/<VTID>/commands.log`, diff only inside the lane's `paths`, no test skipped or loosened, preflight green before each push.

<!-- lane: durable-events -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Tests first: an event with an idempotency key written twice is one row (deterministic id, ignore-duplicates, `[]` = duplicate); unkeyed writes unchanged; the stage writes with `dedupe_key`; issue facts only for the intake label, no title, description or user written; `failed_jobs` only on failed pipelines.
- [ ] T2 Implement in `oasis-event-service.ts`, `types/cicd.ts` (also every event type of this plan), `gitlab-events/delivery-mapper.ts`, `gitlab-events/delivery-stage.ts`.
- [ ] T3 Delivery, gitlab-events and idempotency suites green; gateway typecheck.
- [ ] T4 PR `VTID-xxxxx (delivery-loop-engine/durable-events): …`.

Acceptance:
- Change types: Backend, Integration.
- **Outcome** — one GitLab fact is one OASIS row however many gateway tasks or deliveries carry it; the loop learns of labelled issues and of which jobs failed.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — `emitOasisEvent(event)` with `idempotency_key` → `{ok, duplicate}`; row id = UUIDv5 layout of sha256("vitana.oasis-event.v1\0env\0topic\0key"); `Prefer: return=representation,resolution=ignore-duplicates`.
- **Staging proof** — the GitLab webhook route still answers 401 JSON to an unsigned POST (read-only); no write on staging.

<!-- lane: loop-engine -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Tests first (`test/delivery-loop/*`, the harness and the real-log fixture): controls, client, fingerprint, intake, heal, review, learn, engine; the silence and claim tests; the one-dispatch-key-per-attempt test.
- [ ] T2 Implement `services/gateway/src/services/delivery-loop/` except `adapters.ts`, `runtime.ts`, `dev-autopilot-gateway.ts`.
- [ ] T3 Loop suites and typecheck green.
- [ ] T4 PR `VTID-xxxxx (delivery-loop-engine/loop-engine): …`.

Acceptance:
- Change types: Backend, Integration.
- **Outcome** — the loop observes GitLab, decides intake, repair, review and learning, records every decision before acting, and writes nothing in a quiet cycle.
- **States** — L0..L3 autonomy (default L1); act only at L3 with execution armed; GitLab or OASIS down stops the cycle at the fact.
- **Surfaces / Locales / Accessibility** — n/a.
- **Contract** — `TaskRequest` (`key`, `dispatch_key`, `repair`), `TaskPort`, `ReviewerPort`, `LearnPort` (`ports.ts`); GitLab REST only to allowlisted projects, token only in PRIVATE-TOKEN.
- **Staging proof** — not verified on staging: the loop is off (no `DELIVERY_LOOP_ENABLED`); covered by the lane tests and the slice 7 rehearsal on `vitana/rehearsal`.

<!-- lane: loop-rehearsal -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Tests first: the guard (one project, named writes only, `main` and foreign objects refused by value, lease-checked retry).
- [ ] T2 `scripts/delivery-loop/{rehearse,run-rehearsal,main}.ts`.
- [ ] T3 Guard suite green; one rehearsal run recorded with nothing left behind.
- [ ] T4 PR `VTID-xxxxx (delivery-loop-engine/loop-rehearsal): …`.

Acceptance:
- Change types: Tooling/docs, Integration.
- **Outcome** — an operator can run the real loop against the scratch GitLab project and get a report, with nothing left behind.
- **States / Surfaces / Locales / Accessibility** — n/a.
- **Contract** — writes only to `vitana/rehearsal`, only to objects the run created.
- **Staging proof** — not verified on staging: a script; the run on the real GitLab project is the proof.

<!-- lane: gitlab-executor -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Tests first: the bridge guards (G1, G2, the three helpers), the enqueue, the target, the workspace lease and head check, the gateway, and 4 scenarios in the operator suite (a pushed repair, a repair that changes nothing, a moved branch, no token).
- [ ] T2 `autopilot-agent/gitlab-target.ts`, `dev-autopilot-gitlab-repair.ts`, `delivery-loop/dev-autopilot-gateway.ts`; the GitLab mode of `agent-workspace.ts`, `run-agent-execution.ts`, `dev-autopilot-execute.ts`; the guards in `dev-autopilot-bridge.ts`.
- [ ] T3 Operator suite (75), bridge, fix-mode, merge-conflict, executor-pin, source-type-lock suites, typecheck, full gateway suite.
- [ ] T4 PR `VTID-xxxxx (delivery-loop-engine/gitlab-executor): …`.

Acceptance:
- Change types: Backend, Integration.
- **Outcome** — a failed GitLab merge-request pipeline is repaired by Dev Autopilot on the merge request's own branch; GitHub is never touched for it; the bridge can never close a PR, delete a branch or alter an MR-owned branch, and refuses states it does not handle.
- **States** — no token, invalid target, kill switch on, branch moved, nothing changed, busy (one repair per merge request): each fails closed with a reason and writes nothing to GitLab.
- **Surfaces / Locales / Accessibility** — n/a: no member-facing UI. Callers: the delivery loop's executor port; the executor tick.
- **Contract** — the execution metadata `host: 'gitlab'` + `GitlabTarget`; end status `auto_archived` (pushed) or `failed`; event `dev_autopilot.execution.gitlab_pushed`; push `--force-with-lease=refs/heads/<branch>:<failing sha>`.
- **Staging proof** — not verified on staging: off without `DELIVERY_LOOP_EXECUTOR` and `DEV_AUTOPILOT_GITLAB_TOKEN`; covered by the operator suite scenarios (zero GitHub calls asserted).

<!-- lane: loop-runtime -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Tests first: adapters (learn, reviewer verdict contract, executor port fail-closed), runtime (off means off, no overlapping ticks, status never carries the token), route (read-only, service token), the executor binding.
- [ ] T2 `adapters.ts`, `runtime.ts`, `routes/delivery-loop.ts`, `index.ts` (start behind `DELIVERY_LOOP_ENABLED=true`, non-fatal), `orb/developer/domain-atlas.ts`, `.env.example`.
- [ ] T3 Route guard, role separation (atlas drift guard), loop suites, typecheck, full gateway suite.
- [ ] T4 PR `VTID-xxxxx (delivery-loop-engine/loop-runtime): …`, with `docs/validation/<VTID>/staging-tests.json`.

Acceptance:
- Change types: Backend, Infrastructure/CI (environment documentation only).
- **Outcome** — the loop can be switched on by environment only, says why it does not run, and is observable read-only.
- **States** — not enabled; enabled without GitLab config; executor not named; GitLab down.
- **Surfaces / Locales / Accessibility** — n/a.
- **Contract** — `GET /api/v1/delivery-loop/status`: `requireServiceOrAdmin` (`middleware/require-service-or-admin.ts:71`), 200 JSON, 401 JSON without the token.
- **Staging proof** — staging-tests.json: `GET /api/v1/delivery-loop/status` with the service token → 200 JSON `running:false`; without it → 401 JSON.
