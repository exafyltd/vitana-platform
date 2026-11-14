---
change_class: standard
---
# plan(privacy-ledger-auth): seat names only in the seat file, and production ledger writes ready for `enforce`

Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202611111044-8f1d` (Kiro Web), 2026-11-11. Companion of
`plan(agentic-delivery-v2)`. Premises read at vitana-platform `6dc6e1ba0c` (`origin/main`). No account address appears
in this plan, its files, its commits or its PR body.

Owner, 2026-11-11 (Kiro Web, instructions to Kiro 3), items 4 and 5:
*"Privacy, now: remove the account emails from docs/programs/areas.yaml in a PR that goes through the normal plan gate.
Do not copy emails into any plan, PR body, commit message or log."*
*"Security: the production allocate endpoint runs in `log` mode. Prepare the change to `enforce` as a PR with a test that
an anonymous call returns 401. Do NOT flip the production setting. That is a production write and needs the owner's
command."*
And: *"Prepare a history-rewrite proposal that removes the account emails from every file and commit. Do NOT run it. A
rewrite of a shared branch needs the owner's explicit go, and it is a separate step after the plan."* The proposal is
`history-rewrite-proposal.md` in this folder. It is not a lane, and nothing in this plan runs it.

<!-- plan:begin -->
## Premises (vitana-platform `origin/main` 6dc6e1ba0c)
1. `docs/programs/areas.yaml:14-18`: each of the four seats (`jtadic`, `exafyltd`, `hotmail`, `exafy`) carries an
   `account:` value that is a personal address.
2. No code reads `account`. The readers of `areas.yaml` are `scripts/collab/queue.mjs`, `scripts/eng/gitlab-gates.mjs`
   and `services/gateway/src/services/project-manager/{governance,observe-live,types}.ts`; none of them uses the key.
   The test fixtures `scripts/collab/queue.test.mjs:525` and `:1129` write `{ account: a }` and the parser ignores it.
3. `services/gateway/src/middleware/ledger-write-auth.ts:39-44`: `resolveLedgerWriteAuthMode` returns `log` when
   `LEDGER_WRITE_AUTH_MODE` is unset. In `log` an anonymous ledger write is let through and only logged (`:94-95`,
   `ledger write would be rejected (mode=log)`).
4. `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1286` pins `enforce` on staging. `AWS-PROD-DEPLOY-GATEWAY.yml` sets
   nothing, and `services/gateway/test/vtid-04727-ledger-write-auth.test.ts:223-228` asserts that it does not.
   `services/gateway/src/services/conversation/conversation-flag-pins.generated.ts:111` records
   `{ staging: "enforce", prod: null }`. `scripts/conversation/generate-flag-pins.mjs:6-9` reads the
   `{name:"X", value:"Y"}` entries of both workflows and records a value set from a shell variable as `dynamic`;
   `--check` exits 1 when the generated file is stale (`:14`, `:70`).
5. `services/gateway/src/routes/vtid.ts:144`: `POST /api/v1/vtid/allocate` carries `requireLedgerWriteAuth`. The
   middleware tests already prove that an anonymous request gets 401 in `enforce` (`vtid-04727-ledger-write-auth.test.ts:84-90`).
   No test proves it for the allocate route under the production configuration.
6. `AWS-PROD-DEPLOY-GATEWAY.yml` has 25 `workflow_dispatch` inputs, the GitHub maximum, so the switch cannot be a new
   input. The file is a protected gate file (`scripts/collab/protected-gate-files.json`: `.github/workflows/AWS-PROD-*.yml`).
7. `services/gateway/src/routes/oasis-tasks.ts`, completion route (`:550`): the handler checks the path VTID against
   `^VTID-\d{4,}$` first and answers 400 `INVALID_VTID_FORMAT` (`:555-563`) before any database call. A well-formed VTID
   is read from `vtid_ledger` (`:586`): no row gives 404 (`:598`); a row is updated (`PATCH`, `:663`) and an OASIS event
   follows. STAGING-VERIFY sends a rejected probe with the bearer `staging-verify.invalid.probe` and the body `{}`
   (`scripts/ci/staging-verify/lib.cjs:375-383`).

## Change
### Lane `areas-emails` (vitana-platform, executor kiro, seat exafyltd)
- Remove the `account:` key from the four seats in `docs/programs/areas.yaml`. Seats stay keyed by name; `surface`,
  `automation`, the areas and `exceptions_seat` do not change.
- New test `scripts/collab/areas-no-email.test.mjs` (it runs with the Collab tests, `node --test scripts/collab/*.test.mjs`):
  it fails when `docs/programs/areas.yaml` contains a string shaped like an address (`/[^\s@]+@[^\s@]+\.[a-z]{2,}/i`).
  Red on `origin/main` (premise 1), green after the change. The test reports the line number, never the matched text.
- Nothing else. The other files that still hold these addresses are listed in `history-rewrite-proposal.md` (step 0).
  They are cleaned in later lanes, after this plan.

### Lane `ledger-auth-enforce` (vitana-platform, executor claude: protected gate file)
- `AWS-PROD-DEPLOY-GATEWAY.yml`: add `{name:"LEDGER_WRITE_AUTH_MODE", value:$LWA}` to the existing task-definition
  environment edit. The step gets `PROD_LEDGER_WRITE_AUTH_MODE: ${{ vars.PROD_LEDGER_WRITE_AUTH_MODE }}` as step
  environment and sets `LWA="${PROD_LEDGER_WRITE_AUTH_MODE:-log}"` in its shell before the edit, so the entry is always
  `log` or the variable's value, never an empty string (R1-F1). With the variable unset (today) production gets `log`
  written explicitly, which is the mode it runs now. **Merging this lane changes nothing in production.**
- Regenerate `conversation-flag-pins.generated.ts` (`prod` becomes `dynamic`, premise 4).
- Tests, in `services/gateway/test/vtid-04727-ledger-write-auth.test.ts`:
  - the assertion "production does not set the mode" becomes: production takes the mode only from
    `vars.PROD_LEDGER_WRITE_AUTH_MODE`, with default `log`, and the file never hardcodes `enforce`;
  - new: with the environment production gets when the variable is `enforce`, an anonymous `POST /api/v1/vtid/allocate`
    answers 401 JSON and the allocator is never called (supertest against the `vtid` router, allocator mocked, no
    database);
  - new: with the variable unset, the resolved production mode is `log`;
  - new: the workflow defaults the shell value (`${PROD_LEDGER_WRITE_AUTH_MODE:-log}`), and running the step's environment
    edit on a fixture task definition with the variable unset yields `LEDGER_WRITE_AUTH_MODE=log`, not an empty value;
  - new (probe safety): the exact request STAGING-VERIFY builds for the probe below, sent through the gateway's own
    middleware order (CORS, `sseHeaders`, compression, `express.json`, `delegatedTokenGuard`) and the real tasks router
    with the real `optionalAuth`, answers 401 in `enforce` and 400 `INVALID_VTID_FORMAT` in `log` and `off`, and nothing
    leaves the process: no `fetch`, no JWKS download, no Supabase client call, no OASIS event, no active-day write.
- Staging proof: the staging gateway enforces already. The lane's `staging-tests.json` adds one `http` `rejected_probe`:
  `POST /api/v1/oasis/tasks/VTID-PROBE/complete` on the staging gateway with STAGING-VERIFY's invalid bearer, expecting
  401. That route carries the same middleware. `VTID-PROBE` is not a VTID, so a staging gateway that had lost its pin
  answers 400 before any database call and writes nothing, and the probe still fails, because 400 is not 401
  (premise 7). The allocate route is never probed on a live gateway: a gateway in `log` would allocate a real VTID.
  **Decision (owner, 2026-11-11):** the probe uses `VTID-PROBE`, not `VTID-00000`. A well-formed VTID reaches the ledger
  read, and in `log` mode an existing `VTID-00000` row would be updated; the gateway tags its own system events with
  `VTID-00000` (`services/gateway/src/validator-core/oasis-pipeline.ts:17`), so the code cannot show that no such row
  exists.
- **The flip is the owner's command, outside this lane.** After Gate 2 the owner, when ready:
  1. reads seven days of production gateway logs for `ledger write would be rejected` (CloudWatch Logs Insights on the
     log group of the live `vitana-gateway-awsdr` task definition: `fields @timestamp, @message | filter @message like
     /ledger write would be rejected/ | sort @timestamp desc`) and has every legitimate caller fixed first;
  2. sets `PROD_LEDGER_WRITE_AUTH_MODE=enforce` on `exafyltd/vitana-platform` (repository variable);
  3. runs PUBLISH. Rollback: delete the variable and PUBLISH again.
  A session never sets the variable (`collaboration.md` §7d "Never": repository settings).
- Protected gate file: the owner's instruction of 2026-11-11 (item 5, quoted above) names this change. It is the
  instruction `collaboration.md` §3a requires, together with a reviewer-agent accept on the current head.

## Lanes
| Lane | Repo | Executor | Paths | depends_on |
|---|---|---|---|---|
| `areas-emails` | vitana-platform | kiro, seat exafyltd | `docs/programs/areas.yaml`, `scripts/collab/areas-no-email.test.mjs` | — |
| `ledger-auth-enforce` | vitana-platform | claude | `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml`, `services/gateway/test/vtid-04727-ledger-write-auth.test.ts`, `services/gateway/src/services/conversation/conversation-flag-pins.generated.ts` | — |

The two lanes share no file and run in parallel. `docs/programs/areas.yaml` is a hot file across plans: lane `seats`
of `agentic-delivery-v2` edits it too and starts only after `areas-emails` is done.

## Tests and commands
- `areas-emails`: `node --test scripts/collab/*.test.mjs`; `node scripts/collab/queue.mjs validate`.
- `ledger-auth-enforce`: `cd services/gateway && npx jest test/vtid-04727-ledger-write-auth.test.ts
  test/vtid-04677-scheduled-notifications-auth.test.ts`; `node scripts/conversation/generate-flag-pins.mjs --check`.
- Preflight (`scripts/collab/preflight.mjs`) before every push.

## Measurement
`docs/validation/<plan VTID>/timings.json` (`collaboration.md` §8b).

## Risks
- A production caller that writes the ledger without credentials breaks when the owner flips the variable. Mitigation:
  the seven-day log read before the flip, and the one-step rollback.
- Removing `account:` drops the seat-to-account link from the repository. The link stays in the Kiro account settings
  and in the owner's own records.
- The addresses remain in 113 other files and in git history until the steps of `history-rewrite-proposal.md` run.

## Unchanged
- Staging stays on `enforce`. Production stays on `log` until the owner's command. No route, middleware logic or
  migration changes.
- The history rewrite is not part of this plan.
<!-- plan:end -->
