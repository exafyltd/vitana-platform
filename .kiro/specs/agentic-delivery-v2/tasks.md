# Tasks — agentic-delivery-v2 (Wave 1)

Every lane: code starts only after its VTID is allocated by PLAN-SPAR; each new behaviour's test is written first and
recorded red on `origin/main` in `docs/validation/<VTID>/commands.log`; preflight before every push; no account address in
any file, commit message, PR body or log; seat names only.

<!-- lane: vtid-on-pr -->
Repo `exafyltd/vitana-v1`. Plan §9.
- [ ] T1 `scripts/ci/pr-gate/vtid-on-pr.mjs`: given the PR's file list and live title, decide `allocate | needs-plan | skip`
      with `frontendSimpleViolations` from `lib.mjs`; build the allocate request (`source: ci-vtid-on-pr`) and the new title.
- [ ] T2 `scripts/ci/pr-gate/__tests__/vtid-on-pr.test.mjs` (runs in the PR-GATE self-test, `node --test
      scripts/ci/pr-gate/__tests__/*.test.mjs`): a frontend-simple diff allocates once and retitles; a non-simple diff
      comments and allocates nothing; a title with a VTID, a fork head or a repeated event does nothing; a 401 or 409 from
      the gateway fails once without retry.
- [ ] T3 `.github/workflows/VTID-ON-PR.yml`: `pull_request_target` (`opened`, `reopened`, `synchronize`, `edited`),
      checkout of the base only, file list through the REST API, one concurrency group per PR, `GATEWAY_SERVICE_TOKEN`
      only in the allocate step, `pull-requests: write` only.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-v2/vtid-on-pr): …`.

Acceptance:
- Change types: Infrastructure/CI, Integration.
- **Outcome** — a same-repository PR whose diff passes `frontendSimpleViolations` and whose title has no VTID gets one VTID
  from the ledger and the title `VTID-xxxxx: <title>`; any other PR gets no VTID.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI change.
- **Contract** — the allocate request matches `routes/vtid.ts:144`; no PR code is checked out or executed; the token never
  reaches a step that reads PR content.
- **Staging proof** — not verified on staging: CI-only change; covering tests are the unit tests above.
- Diff only inside the lane `paths`; no protected gate file.

<!-- lane: rules-platform -->
Repo `exafyltd/vitana-platform`. Executor claude (protected `CLAUDE.md`). Plan §9, §18.
- [ ] T1 Write the rule texts of plan §18 items 1–8 into the lane's files, each with the convention "takes effect when the
      lane that builds it is on `main`".
- [ ] T2 PreToolUse hook: an allocation by a session stays denied; a CI allocation is not a session action.
- [ ] T3 Collab tests, `queue.mjs validate`, the Kiro steering guard and the hook's own test green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-v2/rules-platform): …`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — every rule file names the same VTID sources (PLAN-SPAR, VTID-ON-PR until the cut, the delivery service
  after it) and no rule file asks a session to allocate.
- **Contract** — no text conflicts with another rule file (the reviewer checks the 12 places of plan §4 item 1).
- **Staging proof** — not verified on staging: rule text only.
- Protected gate file: the owner's instruction naming this plan (2026-11-11) plus a reviewer-agent accept on the current head.

<!-- lane: rules-v1 -->
Repo `exafyltd/vitana-v1`. Executor claude (protected `CLAUDE.md`). Same texts as `rules-platform` for vitana-v1.
- [ ] T1 v1 `CLAUDE.md` (Plan Sparring Gate), `AGENTS.md`, `.claude/rules/collaboration.md` and
      `.kiro/steering/vitana-owner-autonomy.md` byte-identical to the platform copies after `rules-platform`, the other
      steering files and the PreToolUse hook.
- [ ] T2 v1 tests that read these files green.
- [ ] T3 PR `VTID-xxxxx (agentic-delivery-v2/rules-v1): …`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — the v1 rule files say what the platform files say; `collaboration.md` is byte-identical in both.
- **Staging proof** — not verified on staging: rule text only.
- Protected gate file: the owner's instruction naming this plan plus a reviewer-agent accept on the current head.

<!-- lane: change-classes -->
Repo `exafyltd/vitana-platform`. Plan §7.
- [ ] T1 `config/delivery/change-classes.json`: classes A1, A2, B, P; the A1 lists copied from v1 `lib.mjs:223-238`
      (`e31bf4627`); P from `scripts/collab/protected-gate-files.json`; governance paths from `queue.mjs` `GOVERNANCE_PATHS`.
- [ ] T2 `scripts/eng/change-class.mjs` (`classify(files) → {class, reasons}`) and `scripts/eng/change-class.test.mjs`:
      fixture tables per class; the A1 copy pinned against the v1 lists; a declared class can only be raised.
- [ ] T3 PR `VTID-xxxxx (agentic-delivery-v2/change-classes): …`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — one rule file decides A1, A2, B and P for both repositories; the tests prove each class on fixtures.
- **Contract** — the A1 result equals `frontendSimpleViolations` on every fixture.
- **Staging proof** — not verified on staging: deploys nothing.

<!-- lane: gitlab-accounts -->
Repo `exafyltd/vitana-platform`. Plan §10, Phase 0 P6.
- [ ] T1 `gitlab-settings.json`: accounts `agent-kiro-{delta,echo,foxtrot,golf,hotel,india,juliet,kilo}` (developer) and
      `bot-delivery` (developer), members of `rehearsal` only; token lifetime unchanged (D9 open).
- [ ] T2 `node scripts/eng/gitlab-settings.mjs check --config infra/gitlab-engineering/settings/gitlab-settings.json
      --dry-run` style validation through `scripts/eng/gitlab-settings.test.mjs` green.
- [ ] T3 PR `VTID-xxxxx (agentic-delivery-v2/gitlab-accounts): …`.

Acceptance:
- Change types: Infrastructure/CI.
- **Outcome** — the settings file names 12 Kiro seat accounts and `bot-delivery`; no account is a member of a real project.
- **Contract** — schema version 1 validation passes; no other key changes.
- **Staging proof** — not verified on staging: GitLab settings; applied by the settings sync.

<!-- lane: seats -->
Repo `exafyltd/vitana-platform`. Plan §3 C5. Starts only after `privacy-ledger-auth/areas-emails` is done.
- [ ] T1 `docs/programs/areas.yaml`: seats `delta`, `echo`, `foxtrot`, `golf`, `hotel`, `india`, `juliet`, `kilo`
      (`surface: kiro-web`, `automation: .kiro/automations/<seat>.md`); the four existing seats unchanged; areas unchanged.
- [ ] T2 `.kiro/automations/<seat>.md` for the eight seats (seat name only), and the account addresses removed from
      `exafy.md`, `exafyltd.md`, `jtadic.md`.
- [ ] T3 `scripts/collab/automations.test.mjs` and `queue.mjs validate` green.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-v2/seats): …`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — 12 Kiro seats by name, one automation file each; no address in any seat file.
- **Contract** — seat names match `SEAT_RE`; every seat with `automation` has its file.
- **Staging proof** — not verified on staging: deploys nothing.

<!-- lane: gitlab-mr-vtid -->
Repo `exafyltd/vitana-platform`. Plan §9 (after the cut).
- [ ] T1 `services/delivery/mr-vtid/`: on a GitLab `merge_request` `open` event, read the MR's changes with the
      `bot-delivery` token, classify with `config/delivery/change-classes.json`, allocate in-process, set the ledger row,
      set title and labels, post one note, emit `vtid.allocated`; idempotent per project and MR; `is_test` in rehearsal.
- [ ] T2 Wire it into `routes/internal-gitlab-webhook.ts` behind `DELIVERY_HOST_<REPO>=gitlab`.
- [ ] T3 `services/gateway/test/delivery/mr-vtid.test.ts` with an in-memory ledger and a fake GitLab.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-v2/gitlab-mr-vtid): …`.

Acceptance:
- Change types: Backend, Integration.
- **Outcome** — an A1 or A2 MR without a VTID gets one within one webhook delivery; a B or P MR gets none.
- **Contract** — the webhook's signature check and replies are unchanged; no new route file.
- **Staging proof** — the existing webhook staging probe still answers 401 unsigned; behaviour is proven by the tests.

<!-- lane: delivery-bedrock -->
Repo `exafyltd/vitana-platform`. Plan §10, §11, Phase 0 P3.
- [ ] T1 `scripts/aws/setup-delivery-bedrock.sh`: dry run by default; `--apply` creates role `vitana-delivery-bedrock` in
      the engineering account (Bedrock invoke on the `eu.` profiles of plan §14.1 and, if D13 = A, DeepSeek V3.2 in
      `eu-north-1`) trusting the staging gateway task role; prints the model-access and quota steps; refuses any other
      account.
- [ ] T2 `providers/bedrock.ts`: delivery stages assume that role; every other stage keeps the task role.
- [ ] T3 `services/gateway/test/delivery/bedrock-role.test.ts`.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-v2/delivery-bedrock): …`.

Acceptance:
- Change types: Backend, Infrastructure/CI.
- **Outcome** — delivery calls use the engineering account's Bedrock quota; member-facing calls are unchanged.
- **Contract** — with the role unset, behaviour is byte-identical to today.
- **Staging proof** — the gateway smoke suite; delivery stages proven by the tests.

<!-- lane: review-service -->
Repo `exafyltd/vitana-platform`. Plan §12, §14.
- [ ] T1 `services/delivery/review/`: checklist, tool loop, verdict schema, model chain per class (D12; last tier per D13),
      two accepts for class P, OASIS `delivery.review.verdict` with model and tier.
- [ ] T2 `routes/delivery-review.ts` (`POST /api/v1/delivery/review`, `requireServiceOrAdmin`), mount in `index.ts`, atlas
      claim in `orb/developer/domain-atlas.ts`, stages in `constants/llm-defaults.ts` (also the partner model constants).
- [ ] T3 `services/gateway/test/delivery/review.test.ts`: verdicts on fixture PRs, fallback order, class P double review,
      no non-Bedrock provider unless D13 allows it, 401 without credentials.
- [ ] T4 PR `VTID-xxxxx (agentic-delivery-v2/review-service): …`.

Acceptance:
- Change types: Backend, Integration.
- **Outcome** — a green lane PR gets an accept or changes verdict with findings, the model and the tier.
- **Contract** — read-only toward GitHub; no write route other than the review call; the role-separation drift guard green.
- **Staging proof** — `staging-tests.json`: an anonymous `POST /api/v1/delivery/review` answers 401 (`rejected_probe`).

<!-- lane: reviewer-identity -->
Repo `exafyltd/vitana-platform`. Executor claude (protected `governance.ts`). Plan §12.
- [ ] T1 `REVIEWER_AGENT_MODELS` and its mirror in `guard.cjs` accept `bedrock:<model>` for the models of plan §14.1.
- [ ] T2 `governance.test.ts`, `guard.test.cjs` green.
- [ ] T3 PR `VTID-xxxxx (agentic-delivery-v2/reviewer-identity): …`.

Acceptance:
- Change types: Backend, Tooling/docs.
- **Outcome** — a review entry `agent:vitana-lane-reviewer (bedrock:<model>)` counts for the merge rule; any other model
  name still fails.
- **Staging proof** — not verified on staging: merge-rule code, proven by its tests.
- Protected gate file: the owner's instruction naming this plan plus a reviewer-agent accept on the current head.

<!-- lane: review-workflow -->
Repo `exafyltd/vitana-platform`. Plan §12.
- [ ] T1 `.github/workflows/REVIEW-BEDROCK.yml`: on the completion of the required checks of a lane PR in `in-review`, and
      on `repository_dispatch` from vitana-v1; checkout of `main` only; calls the review service; writes the §3 review entry
      where `.kiro/pipeline/lane-review.md` puts it, with a token that starts the PR's checks.
- [ ] T2 `scripts/ci/review-bedrock/review-bedrock.mjs` and its tests (entry format, trailers, head binding, one review per
      head and model, no write on an error).
- [ ] T3 PR `VTID-xxxxx (agentic-delivery-v2/review-workflow): …`.

Acceptance:
- Change types: Infrastructure/CI, Integration.
- **Outcome** — no session is needed between "checks green" and "review entry on the PR".
- **Contract** — the entry passes `land-guard.mjs review` and Lane scope unchanged.
- **Staging proof** — not verified on staging: CI-only change.

<!-- lane: review-dispatch-v1 -->
Repo `exafyltd/vitana-v1`. Plan §12.
- [ ] T1 `.github/workflows/REVIEW-BEDROCK-DISPATCH.yml`: on the completion of v1 PR checks, a `repository_dispatch` to
      vitana-platform with repository, PR and head only.
- [ ] T2 `scripts/ci/pr-gate/__tests__/review-dispatch.test.mjs`: the workflow checks out no PR code and sends no secret.
- [ ] T3 PR `VTID-xxxxx (agentic-delivery-v2/review-dispatch-v1): …`.

Acceptance:
- Change types: Infrastructure/CI.
- **Outcome** — a v1 lane PR gets its Bedrock review the same way as a platform PR.
- **Staging proof** — not verified on staging: CI-only change.

<!-- lane: spar-responder -->
Repo `exafyltd/vitana-platform`. Executor claude (protected sparring files). Plan §11, §14.3. Its last tier waits for D13.
- [ ] T1 The responder pass after a round without `responses-<n>.md` (grace period, default 0 for autopilot runs).
- [ ] T2 Partner and responder chains per D12; the last tier per the owner's D13 answer.
- [ ] T3 `slot.mjs` cap from 2 to 8 once delivery stages run on the engineering account.
- [ ] T4 Tests for the responder, the chains and the cap.
- [ ] T5 PR `VTID-xxxxx (agentic-delivery-v2/spar-responder): …`.

Acceptance:
- Change types: Backend, Infrastructure/CI.
- **Outcome** — a plan PR converges or escalates without a planner session; every call records model and tier.
- **Contract** — round caps, evidence floor and policy approval unchanged.
- **Staging proof** — the gateway smoke suite; sparring proven by the tests.
- Protected gate files: the owner's instruction naming this plan plus a reviewer-agent accept on the current head.

<!-- lane: retire-vtid-allocate -->
Repo `exafyltd/vitana-platform`. Plan §9 (R1-F2). Starts after `vtid-on-pr` is done.
- [ ] T1 Delete `.github/workflows/VTID-ALLOCATE.yml`.
- [ ] T2 Check that no workflow, script or test still dispatches or reads it (`git grep -n VTID-ALLOCATE` outside
      `.kiro/specs/**` and `docs/validation/**`); the rule texts are changed by `rules-platform`.
- [ ] T3 PR `VTID-xxxxx (agentic-delivery-v2/retire-vtid-allocate): …`.

Acceptance:
- Change types: Infrastructure/CI.
- **Outcome** — CI allocates VTIDs only through PLAN-SPAR and VTID-ON-PR.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI change.
- **Contract** — no remaining caller of the workflow.
- **Staging proof** — not verified on staging: CI-only change.
- Diff only inside the lane `paths`.
