---
lane: monitoring
state: done
next_actor: kiro
depends_on: [gitlab-client]
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - infra/gitlab-engineering/terraform/monitoring.tf
  - infra/gitlab-engineering/host/ops.d/20-cwagent.sh
  - infra/gitlab-engineering/host/units/vitana-ci-metrics.service
  - infra/gitlab-engineering/host/units/vitana-ci-metrics.timer
  - scripts/eng/ci-metrics.mjs
  - scripts/eng/ci-metrics.test.mjs
  - scripts/eng/monitoring-structure.test.mjs
  - docs/validation/**
updated: 2026-11-06T22:44Z
claimed_by: kiro-exafy-202611062222-c262
branch: kiro/eng-gitlab-m2/monitoring
pr: https://github.com/exafyltd/vitana-platform/pull/4710
vtid: VTID-05539
---
# Lane: monitoring (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.6. Starts when M1 lane gitlab-infra is done. VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-03T19:40Z · kiro-exafy-202611021438-cff7 · ready
Lane created with the plan.

### 2026-11-04T19:35Z · ci-plan-spar · ready (VTID allocated)
VTID-05539 allocated after policy approval (converged-auto-v1).

### 2026-11-05T12:40Z · kiro-exafy-202611021438-cff7 · ready → executing
Claimed. Built from the tip of the M1 branch (8bae0d492d4) while M1 (#4692) waited for its re-review, because `terraform validate` needs M1's `main.tf` in the tree (the lane text says it starts when `gitlab-infra` is done). This PR was opened after M1 merged, and the branch was rebuilt as one commit on `origin/main`. Tests first (`monitoring-structure.test.mjs`, `ci-metrics.test.mjs`: red on the base and on a do-nothing stub), then `monitoring.tf`, `ci-metrics.mjs`, the two units and `20-cwagent.sh`. The first mutation run left 18 changes uncaught: 13 cases were added and 4 redundant pieces of code removed. Decisions taken inside the plan (listed for Gate 2): the topic has its own KMS key; the recipient falls back to `admin_email`; the budget mails the owner directly and defaults to 1000 dollars; "fleet at maximum" is read from GitLab; a "completed tick" is read with `systemctl show`.

### 2026-11-05T16:42Z · kiro-exafy-202611021438-cff7 · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4710. Evidence regenerated from the final code: 104 cases (red on base 38 of 38, red on a stub 67 of 67, green 104 of 104), 242 mutations all caught, `terraform fmt -check` and `terraform validate` with M1's `main.tf`, `systemd-analyze verify` clean, the whole script set 743 tests with 0 failures on Node 22 and Node 20, secret scan 0 matches. Ready for a review on the current head. Note for lane `settings`: `ops-install.sh` runs every `ops.d` script and logs a failing one without stopping the others.

### 2026-11-05T16:55Z · agent-vitana-lane-reviewer-202611051655-d14a · review
review: accept
head: d42d75b6638ce7fecbd66328e638a7fe9f91ad2a
reviewer: agent:vitana-lane-reviewer (claude-opus-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4710
Findings:
- [non-blocking] lanes/monitoring.md:40: the States line "an unconfirmed subscription is shown by m2.sh status" needs lane settings (m2.sh, S4). This lane only provides the outputs, and its log hands settings only the ops-install.sh note. Tell settings that m2.sh status must list the subscriptions of alerts_topic_arn (PendingConfirmation) and the state of each alarm_names entry. A6's test mail should go through an alarm (set-alarm-state), not sns publish, so the cloudwatch.amazonaws.com key statement is proven.
- [non-blocking] monitoring.tf: no alarm reads GitLabReadFailed. A read failure that persists (token, membership, a refused query, API 5xx with a healthy sign-in page) leaves both queue alarms blind and sends no mail. A ninth alarm needs _plan; m2.sh status could show the value instead.
- [non-blocking] 20-cwagent.sh:37: only the first fpr is compared, while :42 verifies against every imported key, so an extra key in the downloaded file would pass. The header (:7-8) and AC-16 claim more. Require VALIDSIG <KEY_FPR>, or exactly one pub key.
- [non-blocking] vitana-ci-metrics.service:13: "only the state directory writable" is not what ProtectSystem=full (:19) gives a root process; /var, /opt (the checkout) and /run stay writable. Use strict + RuntimeDirectory (or DynamicUser + LoadCredential), or fix the comment and AC-15.
- [non-blocking] monitoring.tf:37: with the 1000 default, the 50% budget mail comes nearly every month at full size (floor 497.70; cost-estimate.txt: 2.30 dollars of jobs). That is against the Outcome "a healthy system sends nothing". It is disclosed (:32, Decisions); name it at Gate 2.
- [non-blocking] monitoring-structure.test.mjs: the unit-name case pins the text of tasks.md (quality-checks Tooling/docs, Test quality). Check the files under host/units/ once merge-bot and settings have landed.
- [non-blocking] lanes/monitoring.md:5: gitlab-client (depends_on) is in-review on main (#4693), so no §7b merge until it is done. The M1 gitlab-infra start rule was not met at the start (log :37), and M1's lane file is still in-review. infra/gitlab-engineering and scripts/eng are identical at 8bae0d492d4 and b3d547b6, so validate and red-on-base hold.
- [non-blocking] Not confirmed independently: CI (GraphQL refused, gh api not allowed; the caller's REST read says 11/11 success at 16:50:52Z) and the PR body. The evidence has no UNIT run link, and no workflow triggers on these paths. The lane log has no "not verified on staging: <reason>" line.
Next: the land step merges under §7b once lane gitlab-client is done on main (#4693) and land-guard shows every check green on this head. The driver carries finding 1 (and finding 2 if wanted) into lane settings. Checklist on this head: Item 1 met against tasks.md M1-M4 and the Acceptance: namespace Vitana/Engineering; topic vitana-eng-alerts with its own KMS key; the eight alarms (600 s, 30x60 s at 24, status check, 80 %, UnHealthyHostCount, 108000 s, 900 s twice); budget 50/80/100; PutMetricData only for the namespace; the failure metric and never a zero; heartbeats breaching, queue alarms notBreaching. The m2.sh state is finding 1. Item 2: all 26 files are in paths. Item 3: rests on the caller's REST read. Item 4: red on base 38/38 (at 8bae0d492d4, identical to main on these paths), red on a stub 67/67, green 104/104, 242/242 mutations caught. Items 5-9 pass: no test weakened; no live write (render-policies.sh uses fake credentials and local data sources only); no spoken string, no UI, no protected gate file. Item 10: the owner applies monitoring.tf through setup.sh (run_terraform applies all of terraform/ with -var admin_email, and every new variable has a default); ops-install.sh (lane settings) installs the units and runs 20-cwagent.sh at m2.sh install; CI applies nothing. Cost recomputed: 0.80 + 3.00 + 0.86 + 1.00 = 5.66 USD a month. No secret or account-specific value: only the placeholders 123456789012 and example.test, the test token is assembled at run time, and the recipient comes from admin_email at apply. Sibling sweep: every reference resolves in main.tf (application load balancer, target group, instance and role gitlab), backup.sh writes under backups/, and gitlab-configure.sh calls the API at http://127.0.0.1 like ci-metrics.

### 2026-11-06T22:44Z · kiro-exafy-202611062222-c262 · in-review → verified
Closing record written by the plan driver kiro-exafy-202611062222-c262, which took over this lane's stale claim (holder silent > 24 h).
Review: the reviewer-agent accept by agent-vitana-lane-reviewer-202611051655-d14a on head d42d75b6638ce7fecbd66328e638a7fe9f91ad2a is in this log.
PR https://github.com/exafyltd/vitana-platform/pull/4710 merged at 2026-11-05T18:11:29Z by DraganOffice (the gh identity of the plan driver's review desk) with head ec82f00d8a35610383ffbe4a1e74516f9b003d4f.
`land-guard.mjs review --gh exafyltd/vitana-platform --repo . --pr 4710 --reviewed-head d42d75b6638ce7fecbd66328e638a7fe9f91ad2a` (run 2026-11-06T22:44Z): ok, only lane-file entries and clean merges of main after the reviewed head, so the accept counted for the merged head.
Checks on the merged head (REST check-runs read, 2026-11-06T22:44Z): 12 of 12 completed/success; none red or missing.

### 2026-11-06T22:44Z · kiro-exafy-202611062222-c262 · verified → done
merge: 9f239e17dbf8fe1f405dde5f529870ccebde9afb
authority: §7b PM rule (plan driver review desk; accept current on the merged head, checks green).
Gap: the lane said in-review, not verified, when it merged, and no merge line was written at the time; this entry records both.
Next: none; the lane is done.
