# Tasks — kaf-fallback-env
Authoritative plan: `plan.md` (between the plan markers). Lane files: `lanes/`. VTIDs: allocated by CI PLAN-SPAR after
policy approval, one per lane; never by hand. Every lane: branch `kiro/kaf-fallback-env/<lane-id>`, PR title
`VTID-xxxxx (kaf-fallback-env/<lane-id>): …`, trailers `Collab-Session` + `Collab-Lane: kaf-fallback-env/<lane-id>` on
every commit, identity `kiro-agent[bot]`, no `Co-Authored-By: Claude` trailer, evidence in `docs/validation/<VTID>/`
(`commands.log` with every command and pass/fail counts, `outputs/red-on-base.txt` + `outputs/green-head.txt` for every
new test, `acceptance.md` with `TEST:`/`CURL:` lines, `staging-tests.json`). Both lanes build in parallel; merge order
`ff-stage-env` then `ff-pm-flag` (plan §4). Acceptance below is what the reviewer agent `vitana-lane-reviewer`
(claude-sonnet-5.5) checks the PR diff against.

<!-- lane: ff-stage-env -->
## Lane `ff-stage-env` — `CLAUDE_AVAILABLE` in the staging task definition
- [ ] S1 `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`, step `taskdef` `env:` (after the
      `DEV_AUTOPILOT_SCAN_TOKEN_VALUE` line, `:494`): `CLAUDE_AVAILABLE_VALUE: ${{ vars.CLAUDE_AVAILABLE || 'true' }}`.
- [ ] S2 Same step, jq call (`NEW_DEF=`, `:1136`): add `--arg CLAUDE_AVAILABLE "$CLAUDE_AVAILABLE_VALUE" \` immediately
      before `--arg TASK_ROLE "$TASK_ROLE_ARN" '` (which stays the last arg).
- [ ] S3 Strip list `:1193` → `"PM_AGENT_ENABLED","PM_MODE","CLAUDE_AVAILABLE") | not) ]`; upsert on the `:1221` line →
      `{name:"PM_MODE", value:"live"}, {name:"CLAUDE_AVAILABLE", value:$CLAUDE_AVAILABLE},`. No comment or apostrophe
      inside the jq program.
- [ ] S4 New `services/gateway/test/kaf-staging-claude-available-wiring.test.ts` (pattern
      `test/vtid-05127-phone-verify-switch-wiring.test.ts:13-23`): step env line, `--arg CLAUDE_AVAILABLE` before
      `--arg TASK_ROLE`, `"CLAUDE_AVAILABLE"` in the strip list, the upsert exactly once, no `CLAUDE_AVAILABLE` in
      `AWS-PROD-DEPLOY-GATEWAY.yml`.
- [ ] S5 `docs/validation/<VTID>/staging-tests.json`: `/alive` 200 + the wiring test as `existing`; evidence files.
**Acceptance:**
- The diff touches only `AWS-STAGE-DEPLOY-GATEWAY.yml`, the new wiring test and `docs/validation/<VTID>/**` (+ this
  spec); no `AWS-PROD-*` file, no other workflow.
- `vars.CLAUDE_AVAILABLE || 'true'` sits in the step `env:` (outside `run:`); `'false'` passes through, empty → `'true'`.
- `--arg TASK_ROLE "$TASK_ROLE_ARN" '` is still the last jq arg; the jq program contains no apostrophe and no comment.
- `CLAUDE_AVAILABLE` is both stripped and upserted (no duplicate env entry across deploys), next to `PM_MODE`.
- `test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts` green (size cap 20,000 unchanged) in CI.
- The wiring test's positive assertions fail on `origin/main` (`outputs/red-on-base.txt`) and pass on head.
- `staging-tests.json` is read-only (GET + Jest), no `/mode` expectation, nothing targets production.

<!-- lane: ff-pm-flag -->
## Lane `ff-pm-flag` — an unreadable repo variable falls back to `process.env.CLAUDE_AVAILABLE`
- [ ] P1 `services/gateway/src/services/project-manager/observe-live.ts` `GithubRestReader.variable` (`:697-700`):
      return the value only on a 200 with a string `value`; else throw `GithubHttpError` (import from `./github-rest`)
      naming the status. Do not change `gh()`.
- [ ] P2 `observeClaude` (`:566-571`): variable `true`/`false` → that; read returned `null`/unparseable →
      `parseFlag(env.CLAUDE_AVAILABLE)`; read threw → same env fallback. Leave `:572-590` (4 h inputs) unchanged.
      Update the `GithubReader.variable` contract comment (`:73`) and the header line (`:17`).
- [ ] P3 `services/gateway/test/project-manager/observe-live.test.ts`: tests B1-B7 of plan §5 B with a `fetch` spy and
      `GITHUB_SAFE_MERGE_TOKEN` set/restored in `afterEach`.
- [ ] P4 `docs/validation/<VTID>/staging-tests.json`: `/alive` 200, `/api/v1/project-manager/mode` →
      `{"ok":true,"enabled":true,"mode":"live","executor_mode":"kiro_fallback"}`, `/status` bad bearer → 401,
      `npx jest test/project-manager/observe-live.test.ts` as `existing`; evidence files.
**Acceptance:**
- The diff touches only `observe-live.ts`, `test/project-manager/observe-live.test.ts` and `docs/validation/<VTID>/**`
  (+ this spec); `decide.ts`, `governance.ts`, `github-rest.ts`, `loop.ts`, `types.ts` unchanged.
- `GithubReader.variable` signature stays `Promise<string | null>`; existing fakes need no change.
- A REST 404 on the variable → `observeClaude` uses `env.CLAUDE_AVAILABLE` (B4 red on base, green on head); a readable
  variable still wins over the env (B6); the 4 h rule still yields `no_action_4h` with env `'true'` (B7).
- No new string `workflow_dispatch`, `/dispatches` or `AWS-PROD-DEPLOY` in PM sources (`fallback.test.ts:369-373` green).
- `npx jest test/project-manager test/kiro-autonomy-fallback-proof.test.ts`, `npm run typecheck`, `npm run lint`,
  `npm run build` green; outputs in `docs/validation/<VTID>/`.
- `staging-tests.json` read-only; its `/mode` expectation equals VTID-05277's; nothing targets production.
