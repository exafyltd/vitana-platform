# Runbook: the GitHub bridge

Plan `agentic-delivery` §3.13 and §7, lane `github-bridge`, VTID-05548. Code: `scripts/eng/github-bridge.mjs`. Units:
`host/units/vitana-github-bridge.service` and `.timer`.

## What it does
Some agents can push only to GitHub. The bridge lets them keep working after the cut. Every minute, for
`exafyltd/vitana-platform` → `vitana/vitana-platform` and `exafyltd/vitana-v1` → `vitana/vitana-v1`, it:
- copies every `kiro/*` and `claude/*` branch from GitHub to GitLab. It never copies `main`, `assist/*`, `pm-agent/*`
  or any other name, and it never deletes a branch;
- keeps one GitLab merge request for each open GitHub pull request into `main` from such a branch of the same
  repository. Title and body are the same. A draft pull request becomes a GitLab draft, which cannot be merged. A line of
  the body that starts with `/` gets a backslash, so it cannot run a GitLab quick action. Pull requests from forks are
  ignored;
- updates the merge request it opened when the title or the body changes, and closes it when the pull request closes
  (or stops targeting `main`) without landing. A merge request another account opened is never changed;
- posts each job result of the merge request's head pipeline as a commit status `gitlab/<job name>` on the GitHub
  commit, once the job has a result (a waiting or running job has none yet). It never posts a status that equals the
  latest one of that name on that commit;
- closes the pull request with one comment that links the landed commit, once the merge request has landed.

One writer per branch (plan §3.1 principle 1). The bridge copies a branch only when GitLab does not have it, when GitLab
still has the head the bridge pushed last, or when GitLab has the same history (the GitHub head or one of its
ancestors, for example the M1 mirror's copy). Otherwise the branch is refused: see "A refused branch".

The merge bot is not another writer. Before it lands a merge request it merges `main` into the source branch on GitLab
(eng-gitlab-m2 §3.4, plan §3.5). A clean merge of `main` on top of the bridge's copy (two parents, the second one from
`main`, a tree that is exactly Git's automatic merge) keeps the branch bridged. The results of its pipeline are posted on
the pull request head, the commit GitHub knows. A new push on GitHub is copied over the bot's merge; the bot merges
again. A landing is found from the merged merge request's head (`refs/merge-requests/<iid>/head`), also when that head
is a merge of `main`.

## Where it runs
- The GitLab host, as systemd units installed by `ops-install.sh` from `/opt/vitana/platform` (eng-gitlab-m2 §3.3).
- The service runs as a dynamic user. It can write only its state directory `/var/lib/vitana/github-bridge`:
  `state.json` (which branches the bridge owns, a status cache), `cache/` (git objects) and `tick.lock`.
- Logs are JSON lines in the journal, one per action. They never contain a token.
- A tick that finds `tick.lock` taken ends at once (exit 75, counted as success). Exit 1 means a tick had errors; the
  failed branch or repository is tried again at the next tick. Exit 2 means a usage or configuration error.

## Tokens
Neither token reaches a CI job. Both live in Secrets Manager of the engineering account (KMS key
`alias/vitana-engineering`) and in a file on the host, mode 0600, owned by root. The service reads the files through
systemd credentials (`LoadCredential`), never from the command line or the environment.

GitHub, fine-grained personal access token (owner action A3):
- Resource owner `exafyltd`. Repository access: only `exafyltd/vitana-platform` and `exafyltd/vitana-v1`.
- Repository permissions, and nothing else:
  - Contents: Read and write (read branches, push assist commits to bridged branches);
  - Pull requests: Read and write (list, comment on and close pull requests);
  - Commit statuses: Read and write;
  - Metadata: Read (always on).
- Secret `vitana/engineering/gitlab/github-bridge-token`; host file `/etc/vitana/github-bridge-token`.
- The permissions are listed per endpoint in
  [GitHub's table for fine-grained tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).

GitLab, the bridge's own account (the plan does not name it):
- It needs, on `vitana/vitana-platform` and `vitana/vitana-v1` only: push to branches that are not protected; create,
  update and close merge requests; read pipelines and jobs. The Developer role gives exactly that. It must not be a
  Maintainer: it never merges and never pushes `main` or `assist/*`.
- Token scopes: `api` and `write_repository`.
- The settings sync creates the account and its token, as it does for the other bot accounts (eng-gitlab-m2 lane
  `settings`, extended by lane `cutover` of this plan). It keeps the token in Secrets Manager and writes it to
  `/etc/vitana/gitlab-bridge-token`.

Writing the GitHub token to the host (once, after A3, in an SSM session on the GitLab host). The command prints nothing,
puts no token on a command line, and replaces the file only when the read worked:
```
sudo sh -c 'umask 077; t=$(mktemp /etc/vitana/.github-bridge-token.XXXXXX) || exit 1
  if aws secretsmanager get-secret-value --secret-id vitana/engineering/gitlab/github-bridge-token \
       --query SecretString --output text > "$t" && test -s "$t"; then mv "$t" /etc/vitana/github-bridge-token
  else rm -f "$t"; echo "not written"; exit 1; fi'
```
A tick fails visibly (`AssertPathExists`, the unit shows as failed) while either file is missing.

## Start, stop, status
- Start (the cut, plan §8.2 step 5): `sudo systemctl enable --now vitana-github-bridge.timer`
- Stop (the rollback, plan §8.4, or to pause it): `sudo systemctl disable --now vitana-github-bridge.timer`
- One tick now: `sudo systemctl start vitana-github-bridge.service`
- Next run: `systemctl list-timers vitana-github-bridge.timer`
- Last hour of logs: `journalctl -u vitana-github-bridge.service -o cat --since -1h`

## Dry run
The dry run reads GitHub and GitLab and prints the planned actions as `planned` lines. It writes nothing: no git push
or fetch, no API write, no state write. It reads the service's git objects through a throw-away repository in `/tmp`,
so it can run as root without leaving files the service cannot write. It reads the tokens from the files under
`/etc/vitana/`. After the bridge has run once, take the timer's lock so that no tick runs at the same time:
```
sudo flock /var/lib/vitana/github-bridge/tick.lock node /opt/vitana/platform/scripts/eng/github-bridge.mjs run --dry-run
```
Before the first tick the state directory does not exist yet. Give the dry run an empty one instead:
```
sudo node /opt/vitana/platform/scripts/eng/github-bridge.mjs run --dry-run --state-dir "$(mktemp -d)"
```
A branch whose history it cannot judge without a fetch is printed as `check_history`; a live tick fetches it first and
then copies or refuses it.

## Reading the log
| Event | Meaning |
|---|---|
| `create_branch`, `update_branch` | a branch was copied to GitLab (`update_branch` also copies a force-push) |
| `adopt_branch`, `adopt_and_update_branch` | GitLab already had the same history; the bridge owns the branch from now on |
| `adopt_main_merge` | the merge bot merged `main` into the bridge's copy; the branch stays bridged |
| `check_history` | a dry run cannot judge a branch without a fetch; a live tick fetches it and copies or refuses it |
| `branch_refused` (warn) | another writer: nothing pushed, see below |
| `branch_landed` | the branch's merge request landed and GitLab removed the branch; it is copied again only when GitHub has a new head |
| `create_merge_request`, `update_merge_request`, `close_merge_request` | the merge request of a pull request |
| `merge_request_closed_on_gitlab` (warn) | a person closed the merge request while the pull request is open; it is not opened again for this head; a new head gets a new one |
| `merge_request_not_ours` | an open merge request from a bridged branch was opened by another account; the bridge does not change its title or description |
| `github_writes_paused` (warn) | GitHub answered with a rate limit; statuses and pull request closes wait until it has passed (at least a minute) |
| `post_status` | a `gitlab/<job>` status on the GitHub commit |
| `status_budget_reached` | this tick or this hour posted as many statuses as GitHub allows; the rest follow at a later tick |
| `unknown_job_status` (warn) | a job status this code does not know; posted as pending, never as success |
| `comment_landed`, `close_pull_request` | the merge request landed; the pull request was closed with a link |
| `pull_request_list_inconsistent` (warn) | GitHub's list missed an open pull request; nothing was closed |
| `repo_skipped`, `branch_failed`, `pull_request_failed`, `merge_request_failed` (error) | an API or git error; nothing changed for it; tried again at the next tick |
| `tick_done` | the counts of one tick |

## A refused branch
The bridge refuses a branch when GitLab already has it with other history: GitLab's head is not the head the bridge
pushed last, and it is not part of the GitHub branch's history. Usually a seat with a GitLab login pushed a branch of
the same name to GitLab, or a person pushed to the GitLab copy. Nothing is pushed and nothing is lost. The bridge
reports it once for each GitLab head, and it opens no merge request for the pull request of that branch.
1. Find it: `journalctl -u vitana-github-bridge.service -o cat | grep branch_refused`. The line names the repository,
   the branch, `gitlab_head` and `github_head`.
2. Decide which side holds the work. Compare the two heads, for example in the GitLab and GitHub web pages.
3. The GitHub branch is the work: delete the GitLab branch (GitLab: Repository → Branches). The next tick copies the
   GitHub branch and opens the merge request. Look at the branch's merge request first: never delete a branch whose
   merge request is being landed (queue label `queue-updating`).
4. The GitLab branch is the work: leave it. Ask the GitHub agent to use another branch name, or delete the GitHub
   branch. The bridge keeps refusing it and reports again only when the GitLab head changes.
Never copy one side over the other by hand with a force-push.

## Assist commits
Assist jobs (plan §3.9) cannot hold a GitHub token. For a bridged branch, the commit goes to GitHub through the bridge:
```
sudo flock /var/lib/vitana/github-bridge/tick.lock node /opt/vitana/platform/scripts/eng/github-bridge.mjs assist-push \
  --repo exafyltd/vitana-v1 --branch <kiro/... or claude/...> --commit <sha> --from-ref <GitLab ref that points at it>
```
It pushes only when the branch is a `kiro/*` or `claude/*` branch the bridge copied, GitLab still has the bridge's
copy, the source is a protected assist ref (`refs/heads/assist/...`, plan §3.9) that points at the commit, and the
commit is one commit on top of the GitHub head (a fast-forward). Anything else is refused with exit 3 and pushes
nothing. It works in a throw-away repository and never writes the service's files. The next tick copies the new head to
GitLab. `--dry-run` works here too.

## State and recovery
- A corrupt `state.json` stops the bridge with exit 2 before any call. Keep a copy of the file, then move it away.
- Without a state file the bridge adopts every GitLab branch that has the same history as GitHub and refuses the
  others. It opens no second merge request, posts no second status and writes no second landing comment, because it
  reads GitLab and GitHub before it writes.
- `cache/` holds only git objects. It can be deleted at any time; the next tick fetches again. The first fetch of a
  repository brings its whole history and takes longest.

## Limits
- A push reaches GitLab within about a minute (plan risk R7).
- GitHub allows 5,000 REST calls an hour for the token. A quiet tick makes a few calls per repository; statuses are
  read from GitHub only when a job result changed. Branches are read and copied with git, not the REST API. A rate
  limit ends that repository's tick (`repo_skipped`); the next tick tries again.
- GitHub also allows an account about 80 content writes a minute and 500 an hour
  ([secondary rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). Status
  writes are the bridge's most frequent write, so it posts at most 60 a tick and 450 a clock hour and leaves the rest
  for a later tick (`status_budget_reached`). With many agents pushing at once, results can reach GitHub later than they
  reach GitLab. The merge bot reads GitLab directly, so landing does not wait for them.
- Only job results are posted, never "running". While some jobs still run, GitHub can show only green statuses, so
  a GitHub reader (for example `plan-driver.mjs` checks) can see green early. The merge bot reads GitLab, so landing is
  not affected.
- The bridge copies only `kiro/*` and `claude/*` branches. Pull requests from other branches (for example `pm-agent/*`,
  or the branches the kept GitHub workflows open) get no merge request.
- The bridge stops when no agent pushes to GitHub any more (plan §8.5 step 3).
