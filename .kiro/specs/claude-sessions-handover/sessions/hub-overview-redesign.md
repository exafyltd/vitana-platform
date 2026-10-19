# D - HUB Overview redesign (session_01ESw1mpd9mLUjEmXG7d2Gd5)
- Created 2026-10-03, updated 2026-10-08 20:17; idle. Branch claude/command-hub-overview-redesign-saty3w (vitana-platform, v1 attached).

## Goal
Redesign the Command Hub Overview into an attention cockpit (/ops/attention) with phased delivery plus follow-up Plans C and D.

## Done (all in production as of 2026-10-08, gateway commit ae56178c, /alive 200)
- Overview Phase 0 + Phase 1 cockpit (VTID-04869, VTID-04876); Phases 2-4 (VTID-04885, 04886, 04887).
- Plan D (VTID-04986): screen-inventory generator fixed, /ops/overview-timeseries retired; closed in ledger.
- Sparring code and session rules (VTID-04868). PR numbers other than #3963 not seen by me.

## State now
- exafyltd/vitana-platform#3963 (VTID-04987 Plan C): OPEN, DRAFT, label "decide", head 132f6d2, 7 commits, 35 files; last updated 2026-10-14. CloudWatch ALARM source in cockpit (flag OPS_ATTENTION_CLOUDWATCH_ENABLED, staging only) + two aws scripts. CI was green at session end (current CI unknown). Sparred 3 rounds, owner-approved 2026-10-08.
- Nothing half-deployed.

## Blocked on / needs owner
- Someone with IAM rights must run `scripts/aws/setup-gateway-cloudwatch-read-grant.sh --env staging --apply` (session's IAM user denied; staging and prod share vitana-ecs-task-role).
- VTID-04868: Opus 4.6 AWS Marketplace subscription, or owner OK to use Opus 4.5; GitHub token must be stored in Secrets Manager (server-side sparring partner cannot run until both).
- Final production approval for the flag-on PR.

## Next steps for Kiro
1. Re-check #3963 CI/merge state vs current main (rebase if stale; branch was cut from ae56178c).
2. After grant applied (owner/IAM): merge by rule (Project Manager / Claude Code), watch staging deploy + STAGING-VERIFY.
3. Run `setup-gateway-alb-health-alarm.sh --apply` for prod and staging (needs IAM), then small PR turning the flag on in prod (own VTID, sparred), then Gate 2.
4. Merge, IAM and prod are Claude Code / owner only.

## Gotchas/lessons
- Naming trap: `vitana-tg-gateway-prod` serves STAGING; find target group via ECS service, never by name.
- Staging workflow register step was at 19,969/20,000 chars (GitHub limit); keep edits whitespace-neutral.
- A staging suite cannot sign in, so "source reads ok" needs a signed-in admin check.
