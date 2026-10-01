# Aurora cutover — handoff for a fresh session (2026-09-28, VTID-04722)

**Read this file first, before `AURORA-MIGRATION-STATUS-2026-09-10.md` (3800+
lines, full history) or `AURORA-CUTOVER-RUNBOOK-2026-09-20.md` (the step-by-step
cutover procedure).** This is a tight bridge document: what's actually true
right now, what's genuinely blocked, and what to do next. The other two docs
are the full record and the full procedure — read them when you need depth,
not to reconstruct current state.

Branch for all of this: `claude/aws-supabase-aurora-cutover-oxdie9`, on both
`exafyltd/vitana-platform` and `exafyltd/vitana-v1`.

---

## ⚠️ UPDATE 2026-10-01 (VTID-04755) — supersedes the security-group theory below

**The proxy timeouts are not a security-group problem. Aurora itself is
offline: RDS lost access to its KMS key.** Read live on 2026-10-01:

```
aws rds describe-db-clusters --db-cluster-identifier vitana-aurora-prod
  Status: inaccessible-encryption-credentials   (cluster AND both instances)
  KmsKeyId: arn:aws:kms:eu-central-1:472838866351:key/1cd1f8d1-fc05-4de8-acdd-76e76b8a39d1
  LatestRestorableTime: 2026-09-23T22:44:19Z
```

RDS event timeline (`aws rds describe-events`):

| UTC | Event |
|---|---|
| 2026-09-23 22:30 | "unable to access the KMS encryption key … likely due to the key being disabled" (reader) |
| 2026-09-23 22:47 | both instances stopped |
| 2026-09-30 22:46 | 7-day recoverable window expired → terminal `inaccessible-encryption-credentials` |
| 2026-09-30 22:48 | "RDS recommends that you initiate a point-in-time-restore" |

Consequences:
- **The existing cluster cannot be brought back in place.** Recovery is a
  restore (PITR up to 2026-09-23 22:44Z, or one of ~60 snapshots) into a
  **new** cluster.
- **Every snapshot and the PITR log are encrypted with the same key**, so
  any restore first needs that key usable again. If the key is
  *pending deletion*, that is the most urgent thing in this whole migration:
  `aws kms cancel-key-deletion` + `enable-key` before the waiting period ends,
  or every backup becomes unrecoverable. If it is merely *disabled*, or its
  key policy no longer lets RDS use it, re-enable / restore the policy.
- **No production impact.** Production still reads Supabase
  (`OPERATOR_SQL_READONLY_BACKEND=supabase`; no Aurora errors in
  `/vitana/gateway` logs). Aurora holds only migration copies; Supabase is
  still the source of truth, so a fresh DMS full load into a new cluster is
  also a valid recovery path if the backups are lost.
- No migration doc records any KMS change. Who/what changed the key is
  unknown — this identity has no `kms:*` or `cloudtrail:LookupEvents`.

**What only the owner can do** (this identity has no KMS/CloudTrail access,
and should not be granted KMS write):

```bash
K=1cd1f8d1-fc05-4de8-acdd-76e76b8a39d1; R=eu-central-1
aws kms describe-key --key-id $K --region $R \
  --query 'KeyMetadata.{state:KeyState,mgr:KeyManager,deletion:DeletionDate}'
aws kms get-key-policy --key-id $K --policy-name default --region $R
aws cloudtrail lookup-events --region $R --start-time 2026-09-22T00:00:00Z \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue=$K \
  --query 'Events[?EventName!=`Decrypt` && EventName!=`GenerateDataKey`].[EventTime,EventName,Username]' --output text
# If state is PendingDeletion:  aws kms cancel-key-deletion --key-id $K --region $R
# If state is Disabled:         aws kms enable-key --key-id $K --region $R
```

Then decide: PITR restore to a new cluster (keeps data through 2026-09-23),
or a fresh cluster + DMS full load from Supabase. Either way the Aurora
endpoint changes (or the old cluster must be deleted first to reuse the
name — deletion protection is on; a destructive owner decision), and the
~15 ECS task definitions carrying `vitana-aurora-prod.*` hosts need review.
The EC2 security-group check below is now secondary; only revisit it once a
working cluster exists.

---

## TL;DR

**Not cut over.** The last mile is Step 7 of the runbook (verify the Aurora
Postgres connection actually works from inside AWS's network) — everything
upstream of that (DMS full load, most of the data-access-seam code work) has
been done in prior sessions per the status doc. This session's whole
contribution was chasing down *why* Step 7 keeps failing, and it found a
real, concrete, currently-live cause — not finished, but no longer a guess.

**The one thing genuinely pending right now:** the platform owner was asked to
run two AWS CLI commands (creating + attaching a managed IAM policy granting
this session's AWS identity read-only EC2 networking permissions) and has not
yet confirmed running them. Everything below Step 7 is blocked on that until
it's done, or the owner says they don't want to grant it (in which case: stop
asking, and either do the check with the owner's own hands, or drop it).

---

## What is DONE and verified — don't redo this

- **DMS/Aurora data sync**: per the main status doc's own headline sections,
  a full-load copy of ~560+ tables exists in Aurora. CDC (ongoing replication)
  has a long, documented, mostly-resolved history of connectivity issues
  (stale pooler node, dropped replication slot, wrong secret) — **this
  session did not re-check current DMS task status at all**, so re-verify
  fresh with `aws dms describe-replication-tasks --region eu-central-1`
  before assuming anything from an older dated addendum.
- **VPC PrivateLink endpoints for ECS Exec**: `ssmmessages` and `ec2messages`
  interface endpoints exist in `vpc-05958f035e596fe64` (subnets
  `subnet-0ff45a2051c5e5482`, `subnet-0c786864a28a5a821`, security group
  `sg-0fbcf7b59b1f0d685`) and are `available`. Confirmed via the owner's own
  `describe-vpc-endpoints` output.
- **IAM policy for the ECS task's own SSM agent**: inline policy
  `ECSExecSSMMessages` is attached to `vitana-ecs-task-role`, granting
  `ssmmessages:CreateControlChannel`/`CreateDataChannel`/`OpenControlChannel`/
  `OpenDataChannel`. Confirmed via the owner's own `list-role-policies`
  output (7 inline policies total on that role now).
- **ECS Exec channel itself works end-to-end.** Proven twice: a real SSM
  session actually starts and connects (not "not connected", not "access
  denied") once both of the above are in place and this session's own IAM
  user also has `ecs:ExecuteCommand` (see below). The only failures past
  that point were "no shell binary in this container" and "no interactive
  TTY in this sandbox" — both explained below, neither is a permissions
  problem.
- **This session's own AWS IAM identity (`claude-code-aws-agent`) now has
  `ecs:ExecuteCommand`** — granted by the owner via an inline `put-user-policy`
  (policy name `EcsExecuteCommandSelfGrant`). Confirmed: this session
  successfully called `ecs execute-command` itself afterward.
- **Root cause of "the Aurora proxy doesn't work" is now a fact, not a
  guess.** Read directly from live CloudWatch logs (no exec needed):

  ```
  Log group:  /ecs/vitana-postgrest-aurora-staging
  Stream:     postgrest/postgrest/<task-id>
  ```

  The `postgrest` container (official `postgrest/postgrest:v12.2.3` image,
  running alongside a custom `proxy` sidecar in ECS service
  `vitana-postgrest-aurora-proxy`, task family
  `vitana-postgrest-aurora-staging:6`, cluster `Vitana-ECS-Cluster`) is
  retrying every ~20 seconds and failing every time with:

  ```
  connection to server at "vitana-aurora-prod.cluster-cfk228aiedf3.eu-central-1.rds.amazonaws.com"
  (10.0.31.82), port 5432 failed: Operation timed out
  ```

  "Operation timed out" (not "connection refused", not a DNS failure) means
  packets aren't being answered at all — the leading hypothesis is Aurora's
  own security group not allowing inbound 5432 from the proxy task's
  security group. **Not yet confirmed** — that's the pending item below.

---

## The one pending item, exactly as it stands

This session's AWS identity has **no `ec2:Describe*` permissions at all**
(confirmed via a direct `AccessDeniedException` on `ec2:DescribeSecurityGroups`
naming this identity). To find out *why* Aurora times out, someone needs to
read Aurora's own security group:

```
Aurora cluster:          vitana-aurora-prod
Aurora's security group: sg-0838b2f2dabe87971   (found via `aws rds describe-db-clusters --db-cluster-identifier vitana-aurora-prod --query 'DBClusters[0].VpcSecurityGroups'`)
ECS proxy task's SG:     sg-0fbcf7b59b1f0d685   (already confirmed to have a broad self-referencing allow-all rule — not the problem)
```

The owner was asked to run this (as themselves, in CloudShell — their
identity already has broader access than this session's):

```bash
cat > /tmp/ec2-readonly-policy.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Sid":"Ec2NetworkingReadOnly","Effect":"Allow","Action":["ec2:DescribeSecurityGroups","ec2:DescribeSecurityGroupRules","ec2:DescribeVpcs","ec2:DescribeSubnets","ec2:DescribeRouteTables","ec2:DescribeNetworkAcls","ec2:DescribeVpcEndpoints","ec2:DescribeNetworkInterfaces","ec2:DescribeRegions"],"Resource":"*"}]}
EOF

aws iam create-policy --policy-name Ec2NetworkingReadOnlyGrant --policy-document file:///tmp/ec2-readonly-policy.json

aws iam attach-user-policy --user-name claude-code-aws-agent \
  --policy-arn arn:aws:iam::472838866351:policy/Ec2NetworkingReadOnlyGrant
```

**As of this handoff, there is no confirmation this was run.** A fresh
session should:
1. First just try `aws ec2 describe-security-groups --group-ids
   sg-0838b2f2dabe87971 --region eu-central-1 --query
   'SecurityGroups[0].IpPermissions'` directly — it may already work if the
   owner ran it after this session ended.
2. If it still fails with "no identity-based policy allows", ask the owner
   whether they ran it, and if not, hand them the exact commands above again
   (don't re-litigate why, just re-ask once, plainly).
3. Once readable: check whether `sg-0838b2f2dabe87971` has an inbound rule
   for TCP 5432 from `sg-0fbcf7b59b1f0d685` (or a CIDR covering it). If not,
   **that's the fix** — but adding an ingress rule to Aurora's own security
   group is a real change to shared production-adjacent infrastructure.
   Propose it explicitly to the owner and get a clear go-ahead before running
   it, even though it's additive/low-risk (per the standing "confirm before
   actions with real blast radius" norm) — don't just do it silently.
4. Once Aurora accepts the connection, confirm by re-reading the same
   CloudWatch log stream and watching the timeout errors stop, or by
   restarting the service and checking a fresh task's logs from scratch.

If the owner does not want to grant more IAM permissions, the alternative is
to hand them the raw `describe-security-groups` command to run themselves and
paste back the result — one command, not a back-and-forth.

---

## Older, still-standing structural blockers (unrelated to the above, not touched this session)

These come from before this session and were not re-attempted — they need
either a different access level or a direct, in-the-moment decision from the
owner, not more investigation:

1. **DMS final catch-up reload dispatch is blocked by Claude Code's own
   `[Modify Shared Resources]` safety classifier** (client-side, not AWS).
   `aws dms start-replication-task --start-replication-task-type
   start-replication` (needed because the original CDC replication slot was
   dropped — see the main status doc's 2026-09-12 addenda) cannot be run by a
   Claude Code session even with explicit owner approval in chat. This needs
   either the owner running it themselves, or an explicit Bash permission
   rule added to their Claude Code settings for this specific action.
2. **A cosmetic, non-blocking git cleanup on `vitana-v1` is blocked by the
   `[Git Destructive]` classifier.** The migration branch on `vitana-v1`
   carries one redundant commit (the pre-squash SHA for VTID-04101, whose
   actual content is already safely merged into `main` via PR #1117,
   commit `316535437`). Resetting the branch pointer to clean this up hit the
   destructive-git-action classifier. **This is harmless and not worth
   fighting** — the redundant commit doesn't affect anything; leave it.
3. **General EC2/IAM read access for this session's identity has, at various
   points in this migration's history, been blocked by an actual IAM
   permissions BOUNDARY** (`claude-code-aws-agent-boundary`) — distinct from
   "no identity-based policy allows" (a missing grant, fixable by adding a
   policy, which is what worked for `ecs:ExecuteCommand` and
   `ec2:DescribeSecurityGroups` this session). A boundary DENY cannot be
   overridden by adding more identity-based policy, full stop — only by
   changing the boundary itself, which is a bigger, more sensitive IAM change.
   **This session's own EC2/ECS grants worked via plain missing-policy
   fixes, not boundary edits** — so either the boundary doesn't cover these
   specific actions, or it was narrowed at some point. Don't assume either
   way; the error message tells you which one you're facing (`"no
   identity-based policy allows"` = fixable with a grant; `"explicit deny in a
   permissions boundary"` = needs the boundary itself changed, escalate to
   the owner rather than trying more policy grants).
4. **PR housekeeping**: `vitana-platform` PR #3563 (this branch's PR) was
   closed without merging by a prior session as part of an owner-requested
   stale-PR cleanup, with an explicit note that the branch is kept and the
   PR can be reopened if wanted. Per standing governance, **don't reopen it
   or open a new one unless the owner asks** — commits keep landing on the
   branch regardless of whether a PR is open.

---

## Sandbox/tooling gotchas found this session — save yourself the rediscovery time

- **This sandbox's AWS CLI is v1, not v2.** No `--no-cli-pager` flag exists.
  Use `export AWS_PAGER=""` at the top of a script instead, or every
  multi-line JSON-output command risks opening `less` and garbling your
  terminal output (this happened once this session and made several command
  results unreadable).
- **The SSM Session Manager plugin was not preinstalled.** Had to download
  and install it manually:
  ```bash
  curl -sSL "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o /tmp/session-manager-plugin.deb
  dpkg -i /tmp/session-manager-plugin.deb
  ```
  It's installed now in this container instance; a genuinely fresh sandbox
  will need this step redone before `aws ecs execute-command` can work at
  all locally (it fails with "SessionManagerPlugin is not found" otherwise).
- **`aws ecs execute-command --interactive` fundamentally requires a real
  PTY** (it sends terminal control sequences, e.g. cursor-position queries).
  This sandbox's Bash tool has no interactive TTY, so a session immediately
  gets `Cannot perform start session: EOF` the instant a shell starts —
  **even when permissions, the container, and the shell binary are all
  completely fine.** This is a structural sandbox limitation, not a
  permissions problem. Piping commands via stdin doesn't fix it (same EOF).
  Wrapping with `script(1)` to fake a PTY gets blocked by a separate,
  legitimate `[Credential Materialization]` safety classifier (an
  interactive AWS session's transcript could capture secrets if written to
  disk) — **do not try to route around this one.** If you genuinely need an
  interactive shell inside a container, ask the human to run it themselves
  in their own real terminal.
- **The practical workaround that does work**: read CloudWatch Logs directly
  instead of exec'ing in. If the container already logs what you need (a
  connection error, a startup message), that's a clean, no-PTY-needed path.
  This is exactly how the Aurora-timeout root cause above was found.
- **This IAM user's inline-policy total size is capped at 2048 bytes** (a
  real AWS default limit for IAM users specifically). This identity has
  accumulated enough inline policies across this migration's life that a new
  `put-user-policy` call may fail with `LimitExceeded`. **Use a managed
  policy instead** (`aws iam create-policy` + `aws iam attach-user-policy`)
  for any future grant — separate quota, much larger limit, up to 10
  attached policies per user.
- **This session's own client-side safety classifier will block it from
  granting itself new IAM permissions**, even read-only ones, even when the
  owner has already asked for the underlying task to proceed. This is
  correct and intentional (anti-self-privilege-escalation) — don't try
  another tool/encoding/host to route around it. Ask the owner to run the
  grant themselves instead.
- **When pushing a doc/file update via the GitHub API's
  `create_or_update_file` tool (as opposed to plain `git commit && git
  push`), double- and triple-check the `content` parameter is the actual,
  full, real file content — not a placeholder or label.** This session
  briefly (accidentally) overwrote `AURORA-MIGRATION-STATUS-2026-09-10.md`
  with a 24-byte placeholder string this way, caught it immediately, and
  fixed it with a normal `git merge` (not a force-push) that restored the
  full content without losing anything. If local Bash/git is working, prefer
  it over the GitHub content API for anything beyond a trivial small file —
  it's much harder to make this mistake with a local `Write`/`Edit` +
  `git commit`.

---

## Governance reminders (see CLAUDE.md for the full rules — this is just the relevant subset)

- **Self-allocate a VTID for any new distinct piece of work**, immediately,
  via `SELECT allocate_global_vtid('claude-code', 'infra', '<module>')`
  through the Supabase MCP connection (or the gateway API if reachable) —
  never ask the user whether one is needed. Follow up with an `UPDATE
  vtid_ledger` setting a real title/summary and `status='in_progress'`,
  `spec_status='approved'` when the owner has directly instructed the work.
- **Never write to production Supabase outside this VTID-ledger mechanism.**
  Everything else in this migration is AWS-side.
- **Never take destructive AWS actions, and never delete/stop/economize on
  any AWS resource for cost reasons** — this is a standing instruction for
  this whole effort, independent of the general Claude Code safety rules.
- **Commit with the required attribution trailer** (`Co-Authored-By: Claude
  Sonnet 5 <noreply@anthropic.com>` plus the session link) on every commit,
  per this session's system reminder — check whether that's still current
  for a fresh session, since the session link will differ.
- **Work autonomously; don't pause for permission on routine investigation
  steps.** Only stop and ask when genuinely blocked on something only a
  human can do (an AWS action this identity/classifier can't perform, a
  merge/deploy decision, a real-blast-radius change like an Aurora SG edit).

---

## Recommended next steps, in order

1. Check whether the EC2 read-only managed policy is attached yet (see
   "pending item" above). If yes, proceed to step 2. If no, ask the owner
   once, plainly, and wait.
2. Read `sg-0838b2f2dabe87971`'s (Aurora's) inbound rules. Compare against
   `sg-0fbcf7b59b1f0d685` (the proxy task's SG).
3. If missing, propose the exact ingress rule to add, get explicit
   go-ahead, add it, and verify via the CloudWatch logs that the timeout
   errors stop.
4. Once Aurora is confirmed reachable from the proxy task, re-read the main
   status doc's own DMS/CDC section fresh (don't trust old addenda) to
   confirm current replication state, since that question hasn't been
   re-checked in a while.
5. Only after both of the above are genuinely confirmed working should the
   runbook's later steps (write-freeze, final catch-up reload, cutover) even
   be discussed as a scheduling question with the owner. Nothing here
   authorizes moving straight to a freeze window on its own.
6. The DMS reload-dispatch classifier block (older blocker #1 above) will
   need to be resolved — either the owner runs that specific command
   themselves, or they add a permission rule for it — before the final
   catch-up reload can actually be dispatched by a Claude Code session.
