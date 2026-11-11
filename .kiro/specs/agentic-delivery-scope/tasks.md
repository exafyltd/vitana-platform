# Tasks — agentic-delivery-scope

Code starts only after the VTID is allocated. No address is ever written to a commit message, a PR body, a log or an
evidence file. Every lane: test first, recorded red on `origin/main` in `docs/validation/<VTID>/commands.log`; diff only
inside the lane `paths`; no test skipped or loosened; preflight green before each push.

<!-- lane: model-config -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Test first (`model-config.test.ts`), red on `origin/main`: chains M1/M4/M5 as plan §3, EU region only, DeepSeek `option: C` by default, A/B only with `endpoint_location`, no DeepSeek in M5, Opus 5.5 vision `requires_probe: true`.
- [ ] T2 `config/delivery/models.json` and the loader `model-config.ts` (validate, fail closed with the reason).
- [ ] T3 Gateway typecheck and the test green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/model-config): …`.

Acceptance:
- Change types: Backend, Tooling/docs.
- **Outcome** — every delivery stage reads one model config; an invalid or non-EU config is refused with its reason.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — the JSON shape of plan §9; the loader returns `{ok, config}` or `{ok:false, errors}`.
- **Staging proof** — not verified on staging: the change deploys nothing; covered by the lane test. Nothing reads the config until v2 `review-service` / `spar-responder` wire it.
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: model-probes -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Test first with a fake Bedrock client: AccessDenied/throttled/not-found classified, latency recorded, no DeepSeek image call, no secret in the output.
- [ ] T2 `model-probe.mjs` reads `config/delivery/models.json`, prints one JSON line per model.
- [ ] T3 `node --test scripts/eng/model-probe.test.mjs` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/model-probes): …`.

Acceptance:
- Change types: Tooling/docs, Integration.
- **Outcome** — the operator (or a job with the delivery role) sees which tier of each gate can serve today.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — InvokeModel with a 16-token text body and one 1×1 PNG image block (`services/gateway/src/providers/bedrock.ts:28-33` shape); no write anywhere.
- **Staging proof** — not verified on staging: the change deploys nothing; covered by the lane test. The real run needs the delivery role (P7).
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: traceability -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Tests first: `delivery.*` types outside the allowlist rejected (400); `delivery.checks.passed` stored with status `success`, `delivery.blocked` with `error`; an authenticated caller's `role`/`model` kept; auth via `requireLedgerWriteAuth` (log passes, enforce rejects without token); `/allocate` emits `delivery.vtid.allocated`; timeline orders steps by `created_at`, minutes from recorded times only, `null` when missing.
- [ ] T2 Implement in `events.ts`, `vtid.ts`, `delivery/timeline.ts`.
- [ ] T3 Gateway typecheck and Jest for the two files green.
- [ ] T4 `docs/validation/<VTID>/staging-tests.json`: read-only GET of the timeline route with the service token (JSON 200), and the unauthenticated step write as a rejected probe once staging pins enforce.
- [ ] T5 PR `VTID-xxxxx (agentic-delivery-scope/traceability): …`.

Acceptance:
- Change types: Backend.
- **Outcome** — for any VTID one call shows each recorded step with its server time and the minutes between steps.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — POST `/api/v1/oasis/events` (premise 1) unchanged for non-`delivery.` types; GET `/api/v1/vtid/:vtid/timeline` 200 JSON `{vtid, steps:[{type, at, minutes_since_previous}]}`, 404 for an unknown VTID.
- **Staging proof** — the timeline route answers JSON for an existing VTID; read-only.
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: staging-verify-wiring -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Tests first (`record-oasis.test.cjs`): with `GATEWAY_URL` + token the body goes to `/api/v1/oasis/events`, one per VTID; without the token the direct write runs as today.
- [ ] T2 `record-oasis.sh`, `STAGING-VERIFY.yml` (env for the record step; an optional `configure-aws-credentials` step guarded by the variable).
- [ ] T3 `node --test` / the test runner green; preflight green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/staging-verify-wiring): …`.

Acceptance:
- Change types: Infrastructure/CI.
- **Outcome** — each change VTID gets its own `delivery.staging.verify.*` event; nothing is lost when the token is missing.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — the step event body of plan §9; the workflow never prints the token.
- **Staging proof** — the next STAGING-VERIFY run records one event per VTID (read from GitHub and the timeline route).
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: dispatcher -->
Repo `exafyltd/vitana-platform`. Changes `retry.ts` and its test only (plan §5).
- [ ] T1 Test first (`retry.test.ts`), red on `origin/main`: schedule 15/30/60/120/240/480 min, at most 6 attempts in 24 h, the 7th → blocked with `next_actor: owner`; non-retryable reasons (security, data loss, production write, protected file without its reviews, escalated sparring) never retried.
- [ ] T2 `retry.ts`: pure functions `nextRetry(lane, history, now)` and `isRetryable(reason)`.
- [ ] T3 Gateway typecheck and the test green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/dispatcher): …`.

Acceptance:
- Change types: Backend.
- **Outcome** — the retry schedule and eligibility exist as tested pure functions; nothing calls them yet.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — `nextRetry` returns `{attempt, at}` or `{blocked: true}`; no I/O.
- **Staging proof** — not verified on staging: nothing calls the functions until `dispatcher-pm`.
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: dispatcher-pm -->
Repo `exafyltd/vitana-platform`. Builds after `dispatcher`.
- [ ] T1 Test first (`retry-act.test.ts`): a dry-run tick decides `retry` for an eligible parked lane and writes nothing; a live tick unparks it to `parked_from` through the pm-agent writer (only `PM_AGENT_KEYS` change) and records `delivery.retry.scheduled`; after the 6th attempt it records `delivery.blocked`.
- [ ] T2 `types.ts` (`RetryDecision` in the union), `decide.ts`, `act.ts` (`actRetry`).
- [ ] T3 Gateway typecheck; `npm run test:operator` and the PM tests green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/dispatcher-pm): …`.

Acceptance:
- Change types: Backend.
- **Outcome** — a parked lane with a retryable reason is retried by the machine and, after 6 attempts, recorded as blocked.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — PM decision `{kind:"retry", slug, lane, attempt, at}`; written through `applyLaneChange` (`writers.ts:73`) only.
- **Staging proof** — not verified on staging: the PM runs in dry-run there; covered by the lane tests.
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: heartbeat-30 -->
Repo `exafyltd/vitana-platform`. Round 2 finding R2-F1 (minor, deferred to this lane): a 30-minute heartbeat with the 45-minute alive window leaves no margin for one missed heartbeat. The builder keeps a 15-minute check, caps commits at one per 30 minutes, and does not merge until v2 `rules-platform` settles the alive window (`plan-driver.mjs:30`, `project-manager/types.ts:393`).
- [ ] T1 Test first: `HEARTBEAT_INTERVAL_MS` 30 min; `heartbeat()` skips (ok, `skipped: true`) when its own tip is younger than 30 min.
- [ ] T2 `plan-driver.mjs`.
- [ ] T3 `node --test scripts/collab/*.test.mjs` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/heartbeat-30): …`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — fewer bookkeeping commits; drivers stay alive.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — `heartbeat` output adds `skipped`; exit codes unchanged.
- **Staging proof** — not verified on staging: the change deploys nothing; covered by the lane test.
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: vision-review -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Test first with a fake `invokeBedrock`: image blocks built, M5 order, Opus 5.5 only with a verified probe, never DeepSeek, unparseable → block, no tier → `no_tier`.
- [ ] T2 `delivery/vision/index.ts`.
- [ ] T3 Gateway typecheck and Jest green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/vision-review): …`.

Acceptance:
- Change types: Backend, Integration.
- **Outcome** — a reviewer or STAGING-VERIFY gets one vision verdict per set of screenshots, with the model and tier that served it.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — the verdict shape of plan §9; no route, no write.
- **Staging proof** — not verified on staging: the change deploys nothing; covered by the lane test. Used by v2 `review-service` and `verify-visual`.
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: verify-visual -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Tests first: `visual: true` validated in the manifest; config with `screenshot: "on"` and both viewports; verdict recorded; no role or tier → the test fails `no_tier`; tests without the flag unchanged.
- [ ] T2 `lib.cjs`, `run.mjs`, `visual.mjs`.
- [ ] T3 `node --test` for the staging-verify tests green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/verify-visual): …`.

Acceptance:
- Change types: Infrastructure/CI, Integration.
- **Outcome** — a UI change can prove its screens on staging with screenshots and a vision verdict.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — manifest field `visual: true`; `results.json` row gains `visual: {verdict, model, tier, screenshots}`.
- **Staging proof** — the runner's own suites; no spec opts in until P7 exists.
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: verify-audio -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Test first: the round-trip harness (recorded frames, stubbed upstream, in-memory store) asserts transcript events, audio-ready ack and persona voice id.
- [ ] T2 Add `GET /api/v1/ops/health/orb-bootstrap-latency` to `smoke/gateway.json`.
- [ ] T3 Gateway Jest green; the smoke manifest validates.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/verify-audio): …`.

Acceptance:
- Change types: Backend, Infrastructure/CI.
- **Outcome** — every staging deploy checks the voice bootstrap latency endpoint; CI checks a voice turn end to end without a live service.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — GET only; 200 JSON.
- **Staging proof** — the smoke suite runs the new GET on every gateway STAGING-VERIFY.
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: frontend-simple-block -->
Repo `exafyltd/vitana-v1`. Executor claude (protected gate file), exceptions seat `exafyltd`.
- [ ] T1 Test first: `gate.mjs class` exits 1 when a VTID declares `frontend-simple` and the diff breaks the class (deny-listed file, more than 15 files), 0 otherwise; a workflow test that the `Change class` step has no `continue-on-error`.
- [ ] T2 `gate.mjs` subcommand `class`; the PR-GATE step.
- [ ] T3 v1 `node --test scripts/ci/pr-gate/__tests__` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/frontend-simple-block): …`.

Acceptance:
- Change types: Infrastructure/CI.
- **Outcome** — a PR that claims a simple front-end change but is not one turns red and cannot be merged by an agent.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — PR-GATE check `Change class`; other checks still report under `config.json`.
- **Staging proof** — not verified on staging: the change deploys nothing; covered by the lane test.
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: merge-train-pin -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Add the tests; they pass on base (pin), and a mutation (7 positions, pause removed) makes them fail, recorded in `commands.log`.
- [ ] T2 `node --test scripts/eng/gitlab-land-queue.test.mjs` green.
- [ ] T3 PR `VTID-xxxxx (agentic-delivery-scope/merge-train-pin): …`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — M6 and M7 cannot drift silently.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — n/a: tests only.
- **Staging proof** — not verified on staging: the change deploys nothing; covered by the lane test.
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: templates-t5-t6 -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Tests first: T5 runs only on an owner-triggered pipeline, deploy class, read-only post-deploy check, rollback step; T6 only on a schedule or owner trigger; `pipeline-gen.mjs --check` green.
- [ ] T2 The two template files, `TEMPLATE_FILES`, the generated header, re-rendered outputs.
- [ ] T3 `node --test scripts/eng/pipeline-gen.test.mjs` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/templates-t5-t6): …`.

Acceptance:
- Change types: Infrastructure/CI.
- **Outcome** — the cut has T5 and T6 ready; no pipeline uses them before it.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — GitLab CI template names `.t5-publish`, `.t6-ops`.
- **Staging proof** — not verified on staging: the change deploys nothing; covered by the lane test.
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: rehearsal-13 -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Test first: `LANE_COUNT` 13 and the maximum of `--agents` 13; seed lane 13 exists.
- [ ] T2 `rehearse.mjs`, the seed lane, `m2.sh` (`--agents 13`).
- [ ] T3 `node --test scripts/eng/rehearse.test.mjs` green. The run itself waits for P3.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/rehearsal-13): …`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — the owner's rehearsal command exercises 13 agents.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — CLI flags unchanged except the maximum.
- **Staging proof** — not verified on staging: the change deploys nothing; covered by the lane test.
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: clone-prep -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Test first in the fake-aws test: AccessDenied on describe → "access denied" exit 2; absent → "not found"; the mutation guard tests unchanged.
- [ ] T2 `rehearsal-clone.sh` keeps stderr of the describe and classifies it.
- [ ] T3 `bash scripts/aws/test/rehearsal-clone.sh` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/clone-prep): …`.

Acceptance:
- Change types: Infrastructure/CI.
- **Outcome** — the next `status` run tells whether the production cluster is missing or the role may not read it.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — exit codes 0 (ok), 2 (pre-check), unchanged otherwise.
- **Staging proof** — not verified on staging: the change deploys nothing; covered by the lane test. Dispatched afterwards with `action: status` only.
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: delivery-docs -->
Repo `exafyltd/vitana-platform`.
- [ ] T1 Write both documents from `main` and the handoff records; no address, no secret.
- [ ] T2 Links resolve.
- [ ] T3 PR `VTID-xxxxx (agentic-delivery-scope/delivery-docs): …`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — a reader finds the flow, the gates, the prerequisites and the cutover steps in two pages.
- **States / Surfaces / Locales / Accessibility** — n/a: no member-facing UI.
- **Contract** — n/a: documents only.
- **Staging proof** — not verified on staging: the change deploys nothing; covered by the lane test.
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.

<!-- lane: addr-01 -->
Repo `exafyltd/vitana-platform`. Late lane (plan §8a).
- [ ] T1 Count before (`grep -cE <pattern> <file>`, count only) in `docs/validation/<VTID>/commands.log`.
- [ ] T2 Replace each address with the seat or role name; no other change. 
- [ ] T3 Count after = 0; `node --test scripts/collab/*.test.mjs` and `queue.mjs validate` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/addr-01): no address in this file`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — the file holds no address; every other line is unchanged.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI or runtime change.
- **Contract** — n/a: a document.
- **Staging proof** — not verified on staging: the change deploys nothing.
- No address in the diff text of added lines, the PR body, a commit message or `docs/validation/<VTID>/**` (the removed lines are the only place an old value appears).

<!-- lane: addr-02 -->
Repo `exafyltd/vitana-platform`. Late lane (plan §8a).
- [ ] T1 Count before (`grep -cE <pattern> <file>`, count only) in `docs/validation/<VTID>/commands.log`.
- [ ] T2 Replace each address with the seat or role name; no other change. 
- [ ] T3 Count after = 0; `node --test scripts/collab/*.test.mjs` and `queue.mjs validate` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/addr-02): no address in this file`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — the file holds no address; every other line is unchanged.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI or runtime change.
- **Contract** — n/a: a document.
- **Staging proof** — not verified on staging: the change deploys nothing.
- No address in the diff text of added lines, the PR body, a commit message or `docs/validation/<VTID>/**` (the removed lines are the only place an old value appears).

<!-- lane: addr-03 -->
Repo `exafyltd/vitana-platform`. Late lane (plan §8a).
- [ ] T1 Count before (`grep -cE <pattern> <file>`, count only) in `docs/validation/<VTID>/commands.log`.
- [ ] T2 Replace each address with the seat or role name; no other change. 
- [ ] T3 Count after = 0; `node --test scripts/collab/*.test.mjs` and `queue.mjs validate` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/addr-03): no address in this file`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — the file holds no address; every other line is unchanged.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI or runtime change.
- **Contract** — n/a: a document.
- **Staging proof** — not verified on staging: the change deploys nothing.
- No address in the diff text of added lines, the PR body, a commit message or `docs/validation/<VTID>/**` (the removed lines are the only place an old value appears).

<!-- lane: addr-04 -->
Repo `exafyltd/vitana-platform`. Late lane (plan §8a).
- [ ] T1 Count before (`grep -cE <pattern> <file>`, count only) in `docs/validation/<VTID>/commands.log`.
- [ ] T2 Replace each address with the seat or role name; no other change. 
- [ ] T3 Count after = 0; `node --test scripts/collab/*.test.mjs` and `queue.mjs validate` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/addr-04): no address in this file`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — the file holds no address; every other line is unchanged.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI or runtime change.
- **Contract** — n/a: a document.
- **Staging proof** — not verified on staging: the change deploys nothing.
- No address in the diff text of added lines, the PR body, a commit message or `docs/validation/<VTID>/**` (the removed lines are the only place an old value appears).

<!-- lane: addr-05 -->
Repo `exafyltd/vitana-platform`. Late lane (plan §8a).
- [ ] T1 Count before (`grep -cE <pattern> <file>`, count only) in `docs/validation/<VTID>/commands.log`.
- [ ] T2 Replace each address with the seat or role name; no other change. The edit is a `collab-kiro-governance/_plan` commit (a handoff file is edited only by its plan coordinator, `queue.mjs` `classifyPath`); the plan state is unchanged.
- [ ] T3 Count after = 0; `node --test scripts/collab/*.test.mjs` and `queue.mjs validate` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/addr-05): no address in this file`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — the file holds no address; every other line is unchanged.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI or runtime change.
- **Contract** — n/a: a document.
- **Staging proof** — not verified on staging: the change deploys nothing.
- No address in the diff text of added lines, the PR body, a commit message or `docs/validation/<VTID>/**` (the removed lines are the only place an old value appears).

<!-- lane: addr-06 -->
Repo `exafyltd/vitana-platform`. Late lane (plan §8a).
- [ ] T1 Count before (`grep -cE <pattern> <file>`, count only) in `docs/validation/<VTID>/commands.log`.
- [ ] T2 Replace each address with the seat or role name; no other change. 
- [ ] T3 Count after = 0; `node --test scripts/collab/*.test.mjs` and `queue.mjs validate` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/addr-06): no address in this file`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — the file holds no address; every other line is unchanged.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI or runtime change.
- **Contract** — n/a: a document.
- **Staging proof** — not verified on staging: the change deploys nothing.
- No address in the diff text of added lines, the PR body, a commit message or `docs/validation/<VTID>/**` (the removed lines are the only place an old value appears).

<!-- lane: addr-07 -->
Repo `exafyltd/vitana-platform`. Late lane (plan §8a).
- [ ] T1 Count before (`grep -cE <pattern> <file>`, count only) in `docs/validation/<VTID>/commands.log`.
- [ ] T2 Replace each address with the seat or role name; no other change. The edit goes through `lane_admin: true` (another plan's lane file); no field of that lane changes except the one line.
- [ ] T3 Count after = 0; `node --test scripts/collab/*.test.mjs` and `queue.mjs validate` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/addr-07): no address in this file`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — the file holds no address; every other line is unchanged.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI or runtime change.
- **Contract** — n/a: a document.
- **Staging proof** — not verified on staging: the change deploys nothing.
- No address in the diff text of added lines, the PR body, a commit message or `docs/validation/<VTID>/**` (the removed lines are the only place an old value appears).

<!-- lane: addr-08 -->
Repo `exafyltd/vitana-platform`. Late lane (plan §8a).
- [ ] T1 Count before (`grep -cE <pattern> <file>`, count only) in `docs/validation/<VTID>/commands.log`.
- [ ] T2 Replace each address with the seat or role name; no other change. 
- [ ] T3 Count after = 0; `node --test scripts/collab/*.test.mjs` and `queue.mjs validate` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/addr-08): no address in this file`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — the file holds no address; every other line is unchanged.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI or runtime change.
- **Contract** — n/a: a document.
- **Staging proof** — not verified on staging: the change deploys nothing.
- No address in the diff text of added lines, the PR body, a commit message or `docs/validation/<VTID>/**` (the removed lines are the only place an old value appears).

<!-- lane: addr-09 -->
Repo `exafyltd/vitana-platform`. Late lane (plan §8a).
- [ ] T1 Count before (`grep -cE <pattern> <file>`, count only) in `docs/validation/<VTID>/commands.log`.
- [ ] T2 Replace each address with the seat or role name; no other change. 
- [ ] T3 Count after = 0; `node --test scripts/collab/*.test.mjs` and `queue.mjs validate` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/addr-09): no address in this file`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — the file holds no address; every other line is unchanged.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI or runtime change.
- **Contract** — n/a: a document.
- **Staging proof** — not verified on staging: the change deploys nothing.
- No address in the diff text of added lines, the PR body, a commit message or `docs/validation/<VTID>/**` (the removed lines are the only place an old value appears).

<!-- lane: addr-10 -->
Repo `exafyltd/vitana-platform`. Late lane (plan §8a).
- [ ] T1 Count before (`grep -cE <pattern> <file>`, count only) in `docs/validation/<VTID>/commands.log`.
- [ ] T2 Replace each address with the seat or role name; no other change. 
- [ ] T3 Count after = 0; `node --test scripts/collab/*.test.mjs` and `queue.mjs validate` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-scope/addr-10): no address in this file`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — the file holds no address; every other line is unchanged.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI or runtime change.
- **Contract** — n/a: a document.
- **Staging proof** — not verified on staging: the change deploys nothing.
- No address in the diff text of added lines, the PR body, a commit message or `docs/validation/<VTID>/**` (the removed lines are the only place an old value appears).

<!-- lane: addr-guard -->
Repo `exafyltd/vitana-platform`. Late lane (plan §8a). Builds after `addr-01`..`addr-10`.
- [ ] T1 Write `scripts/collab/no-address.test.mjs`; it prints paths and counts only; red on `origin/main` before the cleanup lanes, green after.
- [ ] T2 `node --test scripts/collab/*.test.mjs` green.
- [ ] T3 PR `VTID-xxxxx (agentic-delivery-scope/addr-guard): no address in agent-written folders`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — a new address in those folders fails CI with its path and count.
- **States / Surfaces / Locales / Accessibility** — n/a.
- **Contract** — the test never prints a matched value.
- **Staging proof** — not verified on staging: the change deploys nothing.
