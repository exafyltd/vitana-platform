# Cutover of delivery from GitHub to our own GitLab (runbook)

Plan `agentic-delivery`, section 8, lane `cutover` (VTID-05545). The commands are `scripts/eng/delivery-cutover.sh` (`status`, `rehearse`,
`apply`) and `scripts/eng/delivery-rollback.sh`. The cutover keys of the settings sync are `scripts/eng/gitlab-settings.mjs` and
`infra/gitlab-engineering/settings/gitlab-settings.json` (section 9). The workflow list is `scripts/eng/github-workflows.json` (section 10); the
measuring tools are `scripts/eng/parity-report.mjs` and `scripts/eng/delivery-metrics.mjs` (section 7). Read `RUNBOOK.md` (milestone 1) and
`RUNBOOK-m2-fleet.md` first: this file uses their account, machine and Systems Manager way of working.

**Status: written and tested against stand-ins. It has not run against the real GitHub, AWS or GitLab.** The branch-protection and workflow calls
to GitHub, the commands on the GitLab machine and the first live landing have never been made. Where this file says what an output means, it is
what the code prints, not something seen on the real systems. `status` only reads. `apply` and `delivery-rollback.sh` change nothing until you give the
plan name (`agentic-delivery`): without it they are dry runs that print each change as `WOULD:`. `rehearse` changes something only with
`--merges-paused` (to open) or when it closes or aborts an open rehearsal. `--dry-run` makes any of the three print `WOULD:` and change nothing.

## 1. The order of things

| When | Who | What |
|---|---|---|
| Before anything | owner | A1 (GitLab sign-in to AWS), A2 (runner classes, bigger machine), A3 (the two GitHub tokens): section 3 |
| Automatic | GitLab | The shadow pipelines run on every mirrored `main` commit (state `shadow`, section 9). Nothing to do |
| When `status` is green except `rehearsal` | owner | The rehearsal, one hour with merges paused: section 5 |
| When `status` is all green | owner | A dry run of `apply`, then `apply agentic-delivery`, your command naming the plan: section 6 |
| During the cut | owner | B1: the Dev Autopilot kill switch in the Command Hub (step 6 waits for it) |
| 10 working days after the cut | owner | The exit criteria (section 7). If they fail, `delivery-rollback.sh` (section 8) |

## 2. Where you run it

AWS CloudShell, signed in as the owner to the management account `472838866351`, region `eu-central-1`. Any other account or region stops the
script before it does anything. It needs `aws`, `git`, `jq` and `node` (CloudShell has them) and `gh`, which CloudShell does not have: unpack the
Linux archive from https://github.com/cli/cli/releases and put `gh` in `~/bin` (CloudShell keeps `$HOME`).

It finds the engineering account by itself (`~/vitana-eng/state.env`, or the account named `vitana-engineering`), assumes
`OrganizationAccountAccessRole` there for one hour, and reaches the GitLab machine through Systems Manager, as `m2.sh` does. It never prints or
copies a token file of the machine. Every script it sends there starts with the line `# vitana-cutover: read <name>` or `write <name>`, which says
whether it only reads (the Systems Manager command history shows it).

It needs one GitHub token with admin rights on both repositories: a classic token with scopes `repo` and `workflow` from an admin account (or a
fine-grained token on both repositories with Administration, Actions and Contents on Read and write). Type it hidden when asked, or export it
first. It lives in that shell only. A clone of `exafyltd/vitana-platform` that can fetch `origin/main` (the script reads the lane files there):

```bash
read -rsp 'GitHub token (admin on both repositories): ' GH_TOKEN; echo; export GH_TOKEN
gh auth setup-git
gh repo clone exafyltd/vitana-platform ~/vitana-platform    # the next time: git -C ~/vitana-platform pull
cd ~/vitana-platform
```

## 3. Before the cut: owner steps A1 to A3

**A1, GitLab signs in to AWS.** `bash scripts/aws/setup-gitlab-oidc.sh --apply` (lane `deploy-path`, plan section 7). Without `--apply` it prints
what it would do. `status` item `a1` passes when the OIDC provider for `gitlab.vitanaland.com` and the roles `gl-v1-staging`,
`gl-platform-staging`, `gl-v1-preview`, `gl-verify`, `gl-record` and `gl-assist` exist.

**A2, runner classes and the bigger machine.** Apply the runner classes with the milestone 2 steps (`RUNBOOK-m2-fleet.md` sections 2 and 3: the
quota request, `bash ~/vitana-eng/setup.sh`, `bash ~/vitana-eng/m2.sh install`). `status` item `a2` passes when the instance runners carry the
tags `vitana-eng`, `vitana-eng-main` and `vitana-eng-deploy` and the GitLab machine is an `m6i.2xlarge`.
The size needs a manual step today: `setup.sh grow` in the repository sets `m6i.xlarge` for both machines, and no lane of this plan changes
`setup.sh`. In your CloudShell copy only, change it first, then grow (GitLab restarts, a few minutes of downtime; do it when no cut is running).
The 2xlarge has 8 vCPUs and the runner 4, so the EC2 vCPU quota must be at least 12: `grow` itself checks only for 8.

```bash
sed -i 's/SIZE_GITLAB=m6i\.xlarge/SIZE_GITLAB=m6i.2xlarge/g' ~/vitana-eng/setup.sh
bash ~/vitana-eng/setup.sh grow
```

**A3, the two GitHub tokens.** Neither token reaches a CI job. Create both as fine-grained tokens, resource owner `exafyltd`, repository access
only `exafyltd/vitana-platform` and `exafyltd/vitana-v1`:

| File on the GitLab machine | Repository permissions | Used by |
|---|---|---|
| `/etc/vitana/github-push-mirror-token` | Contents: Read and write; Workflows: Read and write; Metadata: Read | the push mirror of `main` to GitHub, after the cut |
| `/etc/vitana/github-bridge-token` | Contents, Pull requests and Commit statuses: Read and write; Actions: Read; Metadata: Read | the bridge (`RUNBOOK-github-bridge.md`); `parity-report.mjs` reads GitHub's workflow runs with it, which is why Actions: Read is added to the bridge's list |

Create the push-mirror token as the GitHub account that you will give to `apply --mirror-account`: after the cut GitHub `main` accepts pushes from
that account only. If the organisation asks an administrator to approve fine-grained tokens, approve both.

Put them on the machine in a Systems Manager session. In the console: switch role into the engineering account (`OrganizationAccountAccessRole`;
the account id is `ACCOUNT_ID=` in `~/vitana-eng/state.env`), open Systems Manager, Session Manager, Start session, choose `vitana-eng-gitlab`.
(The host's IAM role can read one secret only, so a new Secrets Manager secret would not reach the machine.) In the session, paste this once. It
asks for each token hidden, writes nothing but the two files (mode 600, owner root) and prints no token:

```bash
sudo bash -c 'umask 077
for f in github-push-mirror-token github-bridge-token; do
  n="/etc/vitana/.$f.new"
  read -rsp "paste the token for /etc/vitana/$f (hidden), then press Enter: " t; echo
  if [ -n "$t" ] && printf "%s" "$t" > "$n" && mv "$n" "/etc/vitana/$f"; then echo "written: $f"; else rm -f "$n"; echo "NOT written: $f"; fi
  t=""
done
ls -l /etc/vitana/github-push-mirror-token /etc/vitana/github-bridge-token'
```

Both lines of `ls` must show `-rw-------` and a size above 0. `status` item `a3` checks exactly that (it does not test the tokens against GitHub: the
bridge token is proved by the bridge dry run, the push-mirror token by the first mirror run, section 6 step 3 and section 7).
The third file, `/etc/vitana/gitlab-bridge-token`, you do not write: the settings sync creates the GitLab account `bot-bridge` and its token.

## 4. Reading `status`

`bash scripts/eng/delivery-cutover.sh status` is read only. It prints one line per item of the checklist of plan section 8.1 and exits 0 only when
all fifteen are green. After you fix one item, `status --item ID` checks just that one (seconds instead of minutes).

```
[ OK ] m1              M1 done -- lanes gitlab-infra and gitlab-verify are done on origin/main
[ OK ] a1              owner step A1 (GitLab sign-in to AWS) -- the OIDC provider and the six gl-* roles exist
[FAIL] a3              owner step A3 (the two GitHub tokens) -- /etc/vitana/github-bridge-token:missing (RUNBOOK-cutover.md step A3)
status: not green: a3 -- the cut does not start (apply refuses)
```

| Item | Green when | If red |
|---|---|---|
| `m1`, `m2`, `m2-rehearsal`, `lanes` | the lane files on `origin/main` say `done`: M1 (`gitlab-infra`, `gitlab-verify`), M2 (`fleet`, `settings`, `merge-bot`, `scm-webhook`, `monitoring`, and `rehearsal` for A1 to A9), and the eight lanes of plan `agentic-delivery` | land the named lane; the line names it |
| `a1`, `a2`, `a3` | section 3 | do the step |
| `shadow-commits` | at least 10 shadow commits per repository | wait; shadow starts when the generated pipeline file reaches the machine's checkout (`bash ~/vitana-eng/m2.sh settings` pulls and syncs now). `no-report` means the parity report could not be made: it needs `config/delivery/services.json` from lane `pipelines` in that checkout and the bridge token file of step A3 |
| `shadow-parity` | `parity-report.mjs` lists no difference that nothing explains | the line names the first one; fix the pipeline or record why GitHub differs |
| `shadow-targets` | first result 1 / 3 minutes and required checks 5 / 10 minutes (typical / slowest 5 %) on the shadow pipelines | the speed work of plan section 5 (warm pool, sharding, caches) |
| `bridge-dry-run` | `vitana-github-bridge.timer` is installed but disabled, and `github-bridge.mjs run --dry-run` ends with `tick_done`, no refused branch, no error | `bash ~/vitana-eng/m2.sh install` installs it; `systemctl disable --now vitana-github-bridge.timer` stops it |
| `rehearsal` | the rehearsal record on the machine says `passed` within 7 days | section 5 |
| `protection-roundtrip` | for both repositories the round trip of the protection (section 5) passed within 7 days, and GitHub `main` still has the protection it was run on. The line names the reason per repository: `never-run`, `failed`, `older-than-7-days`, `protection-changed-since`, `record-unreadable`, `github-did-not-answer` | `bash scripts/eng/delivery-cutover.sh rehearse --protection-only` (it needs no merge pause); a `failed` round trip means the rollback could not restore that protection: fix `protection_restore_body` before the cut |
| `workflows` | every workflow GitHub lists in both repositories is classified in `github-workflows.json`, none is missing, and `github-workflows.test.mjs` passes on the vitana-v1 files read from GitHub | add the workflow to the list (section 10) |
| `bot-config` | `scripts/eng/gitlab-land.mjs` on `origin/main` calls `loadEffectiveProjects` | the merge-queue lane wires it (section 9); without it the bot would not land on the two projects after the cut |

## 5. The rehearsal

The rehearsal proves that GitLab alone can take today's `main` of both repositories to staging and that STAGING-VERIFY passes, before anything is
cut. For about an hour both projects run the delivery pipelines with `DELIVERY_MODE=live` on every mirrored `main` commit, so nobody else may land:
two landings through GitHub would deploy twice. Pause merges (no session merges, the Project Manager merges nothing); the script cannot check it,
so it asks you to say so.

1. `bash scripts/eng/delivery-cutover.sh rehearse --merges-paused`. It runs the checklist (every item except `rehearsal` and
   `protection-roundtrip` must be green). Then the round trip of the protection: for each repository it turns GitHub's current protection of
   `main` into the body the rollback would send, PUTs it back onto `main`, reads it again and requires the same protection. A body GitHub refuses,
   or one it reads back differently, stops the rehearsal here (`rehearse: refused`), with the difference printed: the rollback could not have
   restored that protection. Only then it writes `/etc/vitana/delivery-cutover` with mode `rehearsal`, runs the settings sync and records the rehearsal as `open` in
   `/etc/vitana/delivery-rehearsal.json`. Both projects stay mirror projects. It prints `rehearse: OPEN`.
2. Land two changes through GitHub as usual: one that touches `services/gateway` in vitana-platform and one that touches the community app in
   vitana-v1. The mirror copies them to GitLab within about five minutes; the GitLab main pipelines build, deploy to staging and run STAGING-VERIFY.
3. `bash scripts/eng/delivery-cutover.sh rehearse` again. It reads the GitLab pipelines since the rehearsal opened. With a successful
   `deploy-staging*` job and a successful `staging-verify*` job in each repository it removes the marker (back to `shadow`), dispatches
   `AWS-STAGE-DEPLOY-GATEWAY.yml` and `AWS-STAGE-DEPLOY-FRONTEND.yml` so that staging returns to the GitHub path, waits for both runs (up to 45
   minutes each) and reads the task definition of the staging gateway again. Only when no `DELIVERY_HOST_*` is `gitlab` any more it records
   `passed` and prints `rehearse: PASSED`. Exit 3 with `rehearse: not yet` means the evidence is not there; run it again later.
4. `rehearse --protection-only` runs only the round trip of step 1 (after a change to the protection of `main`, status item
   `protection-roundtrip` is red until it runs again).
5. `rehearse --abort` closes an open rehearsal without a pass (marker removed, state back to `shadow`). With `--dry-run` added, any of these
   steps prints `WOULD:` for each change, makes none and ends with `rehearse: dry run finished, nothing was changed`.

**The cut settings on the staging gateway.** A rehearsal deploy of the gateway applies the cut settings to the staging gateway
(`PM_AGENT_ENABLED=false`, `DELIVERY_HOST_VITANA_PLATFORM=gitlab`, `DELIVERY_HOST_VITANA_V1=gitlab`). `AWS-STAGE-DEPLOY-GATEWAY.yml` keeps every
variable of the running task definition that it does not name, and it does not name `DELIVERY_HOST_*`, so its redeploy leaves them in place and the
staging gateway keeps refusing GitHub merges. The rehearsal (step 3) and rollback step 11 therefore read the task definition again after the redeploy
and stop with exit 1 while a `DELIVERY_HOST_*` is still `gitlab`, printing this command for you (account 472838866351, eu-central-1). It registers a
revision without those variables and rolls the staging service to it; it is a manual staging change outside CI, which the platform rules otherwise
avoid, so run it only when the script asks for it:

```bash
TD=$(aws ecs describe-services --cluster Vitana-ECS-Cluster --services vitana-gateway --query 'services[0].taskDefinition' --output text)
aws ecs describe-task-definition --task-definition "$TD" --query taskDefinition \
  | jq '.containerDefinitions[0].environment |= map(select(.name | startswith("DELIVERY_HOST_") | not)) | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)' > td-without-cut.json
NEW=$(aws ecs register-task-definition --cli-input-json file://td-without-cut.json --query taskDefinition.taskDefinitionArn --output text)
aws ecs update-service --cluster Vitana-ECS-Cluster --service vitana-gateway --task-definition "$NEW"
```

Then run the same `rehearse` (or rollback) command again; it reads the task definition again and goes on. **The lasting fix is one line in
`.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`**: add `DELIVERY_HOST_VITANA_PLATFORM` and `DELIVERY_HOST_VITANA_V1` to the replace list of the
task-definition step (or have the GitLab deploy job write `github` outside `live` mode). That file is a governance path owned by another lane, so this
lane does not change it; until it lands, expect the stop above after every rehearsal.

## 6. The cut

Run it only when `status` is all green. First the dry run, which asks for nothing and changes nothing (it prints the checklist, then `WOULD:` for
each change). Use the login of the GitHub account that owns the push-mirror token:

```bash
bash scripts/eng/delivery-cutover.sh apply agentic-delivery --mirror-account LOGIN --dry-run
```

Then, on your command naming the plan (the plan name on the command line is that command; it also disables `PR-GATE.yml`, a protected gate file):

```bash
bash scripts/eng/delivery-cutover.sh apply agentic-delivery --mirror-account LOGIN
```

It refuses (exit 1, nothing changed) unless `status` is all green and `LOGIN` has push access to both repositories. Each state-changing call is
printed first as `CHANGE: ...`. A step whose result is already in the world prints `already done`. A step that fails undoes what it changed
(`UNDO: ...`) and stops with the command to continue or to go back. About one hour in all.

| Step | What it does |
|---|---|
| 1 | Saves GitHub's current protection of `main` in Secrets Manager `vitana/engineering/gitlab/delivery-cutover/protection-<repo>` (engineering account) and reads it back; only a backup that reads back exactly lets the step go on. A GitHub answer other than 200 or 404 "Branch not protected" (a 502, a 403) stops the step: nothing is saved and nothing is locked. Then it restricts push and merge on `main` to `LOGIN`, removes required checks and reviews, admins included, no force push. Nothing lands on GitHub from here |
| 2 | Runs the GitHub-to-GitLab copy once more, checks that both `main` are the same commit, then disables `vitana-mirror.timer`. It refuses to run the copy once the marker is set |
| 3 | Writes `/etc/vitana/delivery-cutover` with mode `live`, fast-forwards the checkout and runs the settings sync. Both projects become `native`: landing, required jobs, push events, the push mirror of `main` to GitHub, protected `assist/*`, `DELIVERY_MODE=live`. If the sync does not converge it removes the marker again |
| 4 | Disables the workflows marked `disable` in `github-workflows.json` (71 of 160, `PR-GATE.yml` included). It saves the list of those that were active in `vitana/engineering/gitlab/delivery-cutover/workflows-<repo>` and reads it back before the first one is disabled; the rollback enables exactly those |
| 5 | Starts the bridge (`vitana-github-bridge.timer`). Needs `/etc/vitana/gitlab-bridge-token` (the settings sync creates it as soon as a project is in `shadow`) and the A3 file |
| 6 | **B1, yours.** The script reads the public kill-switch state of the production gateway (`GET /api/v1/ops/runtime/autopilot/kill-switch`) and never writes to production. If it is off it tells you to switch Dev Autopilot's kill switch ON in the Command Hub and waits up to 10 minutes. Not set in time: exit 3, nothing is half-done; set it and run the same command again (steps 1 to 5 are skipped) |
| 7 | A read-only check that `DELIVERY_MODE` is `live` on both projects, then it prints that the system is armed. The first landing on vitana-platform `main` that changes the gateway deploys it to staging with the cut settings. A script cannot trigger that pipeline, so this step only checks |
| 8 | Creates the tags `delivery/cutover-vitana-platform` and `delivery/cutover-vitana-v1` at each `main`, on GitHub and on GitLab |

`apply` records `started` (read back before step 1; a record that cannot be written stops it) and then `complete` in
`vitana/engineering/gitlab/delivery-cutover/state`, with the mirror account. Run again within 24 hours of that record it resumes without asking the
checklist again. A record older than 24 hours is resumed only after the checklist is green again (after step 1 the item `protection-roundtrip` stays
red, so in practice that means the rollback). A record `rolling-back` (a rollback that started and did not finish) is never resumed: finish the
rollback first. After a rollback the next `apply` is a new cut and starts with the checklist.

**The lock.** `apply`, `rehearse` and the rollback take the lock `vitana/engineering/gitlab/delivery-cutover/lock` (a secret that Secrets Manager
creates only when it does not exist) before their first change and delete it when they end, so two of them never run at once, for example in two
CloudShell tabs. A second run prints who holds it and since when, and changes nothing. A run that died (CloudShell closed) leaves its lock behind:
when no other run is going on and the lock is older than 6 hours, give `--break-lock` to the same command. A younger lock is never cleared.

Exit codes of all three commands: 0 done, 1 a refusal or a failure, 2 a usage mistake, 3 waiting for you (the kill switch, the rehearsal).

## 7. After the cut

- **Who lands.** The merge bot (`vitana-land.timer`) lands merge requests whose `lane-scope`, `change-suite` and `gate` jobs passed. The bridge
  keeps one merge request per open GitHub pull request, posts each job as the commit status `gitlab/<job>` on GitHub, and closes the pull request
  with a link when it has landed. Agent sessions keep pushing `kiro/*` and `claude/*` to GitHub. The driver notes (`.kiro/pipeline/driver.md`) wait
  for the `delivery.landed` event of a repository whose tag `delivery/cutover-<repo>` exists (`git ls-remote --tags origin`).
- **The push mirror.** In each GitLab project, Settings, Repository, Mirroring repositories: the mirror to `github.com/exafyltd/<repo>.git` shows a
  recent update and no error; GitHub `main` follows GitLab `main` within about a minute. An error that comes from the token: write the right token to
  `/etc/vitana/github-push-mirror-token` (section 3), delete the mirror's row in that page and run `bash ~/vitana-eng/m2.sh settings`. The sync
  creates the mirror again with the token from the file; it never changes the token of a mirror that exists.
- **The first landing** that changes the gateway deploys it with `PM_AGENT_ENABLED=false`, `DELIVERY_HOST_VITANA_PLATFORM=gitlab` and
  `DELIVERY_HOST_VITANA_V1=gitlab`. Until it has run, GitHub's branch protection is what stops a GitHub merge. In the Command Hub the Delivery
  screen shows the numbers below.
- **The old copy account.** `vitana-mirror` is Reporter on both projects while live (`mirror_user_role`), and the old GitHub-to-GitLab copy is off.

**Exit criteria, 10 working days after the cut (plan section 8.3).** Typical / slowest 5 %: first result 1 / 3 minutes, required checks 5 / 10,
accept to `main` 5 / 15, landing to STAGING-VERIFY result 10 / 20, one-lane task 1 / 3 hours. Every landed VTID has a `delivery.landed` event and a
STAGING-VERIFY result. No push to GitHub `main` except by the mirror. No GitHub workflow run on a pull request except `PLAN-SPAR.yml` and
`MIGRATION-DRIFT-CHECK.yml`. Change failure rate no worse than the 30 days before the cut. Cost per day within budget.

The measuring tools are read only (GET requests and one input file), print no token, and write a number as `null` when its source is missing,
never 0. Run them on the GitLab machine, where the token files are:

```bash
cd /opt/vitana/platform
node scripts/eng/delivery-metrics.mjs pipelines --project vitana/vitana-platform --limit 30 --token-file /etc/vitana/bot-metrics-token > pipelines.json
node scripts/eng/delivery-metrics.mjs compute --input input.json --out delivery-metrics.json   # input: schema vitana.delivery-metrics-input/v1
node scripts/eng/parity-report.mjs --repo vitana-platform --limit 30 --min-shadow 10          # prints vitana.parity-report/v1; --gate exits 3 when not ready
```

`delivery-metrics.json` (`vitana.delivery-metrics/v1`) holds each metric with the GitHub baseline of plan section 2.1 (first result 666 s, required
checks 3294 s, landing to verify 3684 s) next to the value after the cut. `parity-report.mjs` needs the workflow map of lane `pipelines`
(`config/delivery/services.json`, `repositories.<repo>.github_workflows`); `--map FILE` points at it.

## 8. Rollback

Within the 10 days, if the exit criteria fail. `bash scripts/eng/delivery-rollback.sh agentic-delivery`, with `--dry-run` first. No commit is lost
and open pull requests never left GitHub, so nothing is reopened. About one hour. In this order:

| Step | What it does |
|---|---|
| 1 | Stops the merge bot (`vitana-land.timer`, `vitana-land.service`) |
| 2 | Waits up to 10 minutes until GitHub `main` equals GitLab `main` in both repositories (the push mirror copies it). Then it compares the head of every branch that exists on both hosts: a GitLab head that GitHub's head does not contain (GitHub's compare API, base GitLab head) stops the rollback and is listed, because the restarted GitHub-to-GitLab copy force-pushes every branch and would rewind it; push those branches from GitLab to GitHub first (there is no flag to let them go). A branch that exists only on GitLab stops the rollback too, because the copy deletes it: push it to GitHub, or run again with `--confirm-prune-gitlab-only-branches`. The bot refs `train/*` and `assist/*` are left out of that check. More than 3000 branches on GitLab (page 30 full) stops it rather than check a cut-short list |
| 3 | Restores the saved GitHub protection of `main` (a `main` that had none gets none), but only while `main` is still the cut's lock (restricted to the recorded mirror account). A protection somebody set since, or one a first rollback restored, is left as it is. A missing or unreadable backup stops here with exit 1 and the manual instruction below; it never counts as restored |
| 4 | Enables again exactly the workflows step 4 of the cut disabled and that are still `disabled_manually`. After a finished rollback it enables nothing. Without the saved list it stops with exit 1 if a workflow of the disable list is disabled |
| 5, 6 | Stops the bridge; starts the GitHub-to-GitLab copy (`vitana-mirror.timer`) again |
| 7 | Removes `/etc/vitana/delivery-cutover` and runs the settings sync: both projects are mirror projects again, the push mirror, landing and `assist/*` are gone, `DELIVERY_MODE=shadow` |
| 8 | Starts the merge bot again (it lands on the rehearsal project only) |
| 9 | Deletes the tags `delivery/cutover-<repo>` on GitHub and GitLab |
| 10 | Tells you to switch the Dev Autopilot kill switch off in the Command Hub when you want it to run again. The script never writes to production |
| 11 | If a `DELIVERY_HOST_*` of the staging gateway task definition is `gitlab` (cluster `Vitana-ECS-Cluster`, service `vitana-gateway`), dispatches `AWS-STAGE-DEPLOY-GATEWAY.yml`, waits for the run, and reads the task definition again. While it is still `gitlab` (today it is: section 5) it stops with exit 1 and the owner command of section 5. Otherwise it prints that nothing is to redeploy |

It records `rolling-back` in the `state` secret before its first change and `rolled-back` at the end. A step that is already undone is skipped, so a
stopped rollback is continued by running it again.

**When the protection cannot be restored** (step 3 or the undo of cut step 1 prints `MANUAL (owner)`): open the repository on GitHub, Settings,
Branches, the rule of `main`. Remove the restriction to the mirror account, and set the required checks, the reviews, the bypass list and the other
settings as they were before the cut. A copy of them is the GET answer in `vitana/engineering/gitlab/delivery-cutover/protection-<repo>` when that
secret can be read. Then run the rollback again; step 3 sees that `main` is no longer the cut's lock and goes on.
Afterwards `bash scripts/eng/delivery-cutover.sh status` shows the checklist as before the cut.

## 9. The settings sync and the cutover keys

`gitlab-settings.json` keeps its milestone 2 keys (`settings/README.md`, unchanged). The cutover adds a top-level `cutover` block and a `cutover`
block in each project. A project without one behaves exactly as in milestone 2. The state of a project is decided by files, not by flags:

| State | When | What the sync makes of the project |
|---|---|---|
| `inactive` | the project has a `cutover` block, but its generated pipeline file (`ci_file`) is not in the CI folder yet | milestone 2: a mirror project |
| `shadow` | `ci_file` is in the CI folder, no marker | still a mirror project; the delivery pipeline runs with `DELIVERY_MODE=shadow`; merge request and pipeline events go to `webhook_url`; no landing |
| `rehearsal` | the marker says `rehearsal` | `shadow`, and `DELIVERY_MODE=live` |
| `live` | the marker says `live` | the `native` profile and the `live` keys below |

The marker is the host file `/etc/vitana/delivery-cutover`. It holds one JSON line,
`{"schema":"vitana.delivery-cutover-marker/v1","mode":"live","plan":"agentic-delivery","at":"<UTC time>"}` (`mode` is `live` or `rehearsal`). A file
without that schema counts as no marker, and the sync reports it. Removing the marker converges the projects back to `shadow`.
`delivery-cutover.sh` and `delivery-rollback.sh` write and remove it; nobody edits it by hand. The sync reads it from `--marker-file FILE`
(default `/etc/vitana/delivery-cutover`). The CI variable `DELIVERY_MODE` (unprotected, unmasked) carries `shadow` or `live` to the pipelines.

| Key | Where | Meaning |
|---|---|---|
| `cutover` | top level, and in each project | the block described here |
| `accounts` | inside the top-level `cutover` | extra GitLab accounts of the cut (the bridge account) |
| `username`, `name` | an `accounts` entry | the GitLab login and display name (`bot-bridge`, "GitHub bridge") |
| `scopes` | an `accounts` entry | the token scopes (`api`, `write_repository`) |
| `token_file` | an `accounts` entry | where the sync writes the account's token: `/etc/vitana/gitlab-bridge-token` |
| `shadow_role`, `live_role` | an `accounts` entry | the role on the projects in each state (Reporter while `shadow`, Developer while `live`) |
| `projects` | an `accounts` entry | the projects it belongs to |
| `github` | project `cutover` | the GitHub repository the push mirror targets (`exafyltd/<repo>`) |
| `ci_file` | project `cutover` | the generated pipeline file whose presence turns `inactive` into `shadow` (`platform-delivery.gitlab-ci.yml`, `v1-delivery.gitlab-ci.yml`) |
| `webhook_url` | project `cutover` | the gateway endpoint for GitLab events (staging) |
| `mirror_user` | project `cutover` | the account of the old GitHub-to-GitLab copy (`vitana-mirror`) |
| `shadow` | project `cutover` | the keys that apply while `shadow` and `rehearsal` |
| `live` | project `cutover` | the keys that apply while `live` |
| `webhook_events` | `shadow`, `live` | `merge_request` and `pipeline`; `live` adds `push` and `tag_push` (plain `webhook.events` of milestone 2 still refuse `push`) |
| `mirror_user_role` | `shadow`, `live` | `vitana-mirror` is Maintainer while `shadow`, Reporter while `live` |
| `landing` | `live` | the merge bot lands on the project |
| `required_jobs` | `live` | `lane-scope`, `change-suite`, `gate` |
| `push_mirror` | `live` | the push mirror of `main` to GitHub |
| `token_file` | `push_mirror` | `/etc/vitana/github-push-mirror-token` |
| `only_protected_branches`, `keep_divergent_refs` | `push_mirror` | both must be true: only `main` is mirrored, and a GitHub ref that diverged is kept, never overwritten |
| `protected_branches` | `live` | extra protected branches: |
| `name`, `push`, `merge` | a `protected_branches` entry | `assist/*`, push and merge at access level 40 (Maintainers; the sync reports any Maintainer other than `bot-land` and the owner), no force push |
| `allow_merge_on_skipped_pipeline` | `live` | a skipped pipeline counts as successful for merging |

Token files, all under `/etc/vitana`, mode 600, owner root: `github-push-mirror-token` and `github-bridge-token` (you, A3),
`gitlab-bridge-token` (the sync, for `bot-bridge`), `bot-land-token`, `bot-metrics-token`, `settings-admin-token` and `mirror-token` (milestone 1 and
2). No token is ever printed, logged or put on a command line; the push mirror's token is stored by GitLab inside the mirror's address.

**The merge bot reads the state too.** `loadEffectiveProjects` in `scripts/eng/gitlab-settings.mjs` returns the projects as the bot needs them (landing
on, required jobs) in the view of the marker. `gitlab-land.mjs` belongs to milestone 2 and the merge-queue lane; until it calls
`loadEffectiveProjects`, `status` item `bot-config` stays red. That is deliberate: a bot that reads the raw file would not land anything after the cut.

## 10. The GitHub workflow list

`scripts/eng/github-workflows.json` classifies all 160 workflows (114 in vitana-platform, 46 in vitana-v1): 71 `disable` (55 and 16) and 89 `keep`. A workflow added to either repository after this list fails `github-workflows.test.mjs` (and the checklist item `workflows`) until it is classified here.
Each entry records its triggers and whether it runs on a push to `main`. A kept workflow says how it behaves after the cut: `main_push` is `none`,
`reads`, `frozen` or `deploys-production`, `dispatch_only` marks the dispatch-only production and migration workflows that PUBLISH and the owner run,
and `pull_request` marks the two that keep running on pull requests (`PLAN-SPAR.yml`, `MIGRATION-DRIFT-CHECK.yml`). `protected: true` marks the
protected gate files: `PR-GATE.yml` (both repositories), `PLAN-SPAR.yml`, every `AWS-PROD-*` workflow and the vitana-v1 production deploy. The only
workflow that deploys to production on a push to `main` is `DEPLOY-CLOUDFLARE-WORKERS` (for a `cloudflare/**` change), as today.
Three kept vitana-v1 workflows commit to the branch they are dispatched on (`git push origin HEAD:${{ github.ref_name }}`): `i18n-translate.yml`,
`i18n-audit-llm.yml` and `i18n-long-words.yml` (their entries say so in `pushes_dispatched_ref` and `note`). The Command Hub dispatches the first two on
`main`. After cut step 1 GitHub refuses those pushes, so they fail on `main`; dispatch them on another branch (a `kiro/*` branch the bridge carries)
until they move to GitLab (T7). The workflow test counts a push to `github.ref_name` as a push to `main` unless the entry records it.
`scripts/eng/github-workflows.test.mjs` reads the platform workflows from the checkout. For the vitana-v1 half, set `VITANA_V1_WORKFLOWS_DIR` to a
folder with the 46 files (`status` item `workflows` fetches them from GitHub and sets it). A new workflow on GitHub makes `status` red until it is
added to the list.

## 11. What is not built, and what is not known

- `bot-assist` (the GitLab account of the assist jobs) and the rotation of `ASSIST_PUSH_TOKEN` (plan section 3.9): not in the tasks of this lane.
- Pipeline schedules (the nightly `DELIVERY_SCHEDULE`) and the `oldest_first` resource group: the pipeline templates say the settings sync does
  them, but the plan gives no task for it. A follow-up lane.
- `apply` step 7 only checks. The first deploy needs a landing that changes the gateway.
- The `A2` machine size (section 3) is manual until `setup.sh` takes the size as an argument.
- The GitHub-side calls (branch protection, workflow enable and disable, tags, workflow dispatch) are tested against stand-ins that implement
  GitHub's documented behaviour. The restore body is tried on the real API by the round trip of the rehearsal; the rest of the first real run is the
  owner's.
- Open findings of the independent review that this lane does not fix: the kept workflows that open pull requests from branches the bridge does not
  copy (`auto/screens-catalog`, `whats-new/*`); `SMOKE-WELCOME-GREETING.yml` losing its `workflow_run` trigger when the staging deploy workflow is
  disabled (its daily schedule stays); no check of the push-mirror token before step 1 and of the mirror's `update_status` after step 3, and rulesets
  on `main` are not read; no signal for agents between cut step 1 and the tag of step 8; `bot-assist` (above) while `I18N-PROPAGATE.yml` is disabled.

## 12. Every call the scripts make

`delivery-cutover.sh` and `delivery-rollback.sh` reach GitHub, AWS and the GitLab machine only through these calls. **W** marks a call that changes
something; each one is printed as `CHANGE:` before it is made, and a dry run makes none of them.

| Where | Call | W |
|---|---|---|
| GitHub | `GET user`; `GET repos/{o}/{r}` (`.permissions.admin`); `GET repos/{o}/{r}/collaborators/{login}/permission` | |
| GitHub | `GET repos/{o}/{r}/branches/main/protection` | |
| GitHub | `PUT repos/{o}/{r}/branches/main/protection` (the lock, the restore, the round trip) | W |
| GitHub | `DELETE repos/{o}/{r}/branches/main/protection` (the restore of a `main` that had none) | W |
| GitHub | `GET repos/{o}/{r}/actions/workflows`; `GET repos/{o}/{r}/contents/.github/workflows/{file}` | |
| GitHub | `PUT repos/{o}/{r}/actions/workflows/{file}/disable`, `.../enable` | W |
| GitHub | `GET repos/{o}/{r}/branches/main`; `GET repos/{o}/{r}/branches`; `GET repos/{o}/{r}/compare/{gitlab head}...{github head}` | |
| GitHub | `GET repos/{o}/{r}/git/ref/tags/delivery/cutover-{r}` | |
| GitHub | `POST repos/{o}/{r}/git/refs`; `DELETE repos/{o}/{r}/git/refs/tags/delivery/cutover-{r}` | W |
| GitHub | `gh workflow run AWS-STAGE-DEPLOY-GATEWAY.yml` (vitana-platform), `AWS-STAGE-DEPLOY-FRONTEND.yml` (vitana-v1), on `main` | W |
| GitHub | `GET repos/{o}/{r}/actions/workflows/{file}/runs?event=workflow_dispatch&branch=main` (the wait for a redeploy) | |
| git | `git fetch origin main`; `git show origin/main:<lane file>` | |
| AWS, management account | `sts get-caller-identity`; `organizations list-accounts`; `sts assume-role` (`OrganizationAccountAccessRole`); `iam list-open-id-connect-providers`; `iam get-role` | |
| AWS, management account | `ecs describe-services`, `ecs describe-task-definition` (the staging gateway, read only) | |
| AWS, engineering account | `ec2 describe-instances`; `ssm get-command-invocation`; `secretsmanager describe-secret`, `get-secret-value` | |
| AWS, engineering account | `ssm send-command` (each script starts with `# vitana-cutover: read <name>` or `write <name>`; only `write` scripts change the machine) | W (write scripts) |
| AWS, engineering account | `secretsmanager create-secret`, `put-secret-value` (the backups, the record, the round trip, the lock), `delete-secret --force-delete-without-recovery` (the lock only) | W |
| GitLab machine, `127.0.0.1/api/v4` | `GET runners/all`, `repository/branches`, `variables/DELIVERY_MODE`, `repository/tags/...` | |
| GitLab machine | `POST repository/tags`, `DELETE repository/tags/...`; `systemctl` on the five named units; the marker and rehearsal files; the settings sync (variables, remote mirrors, protected branches, members, `allow_merge_on_skipped_pipeline`) | W |
| Production | `GET /api/v1/ops/runtime/autopilot/kill-switch` (public, read only) | |

