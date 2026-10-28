# Tasks — claude-sessions-handover

Index and priorities: `handoff.md`. Detail per session: `sessions/<name>.md`. This spec has **no lanes of its own**: the
work it points to lives in the lanes of the specs named below, or starts as a `plan(<slug>)` PR. Acceptance for every item:
its own PR checks green (incl. Lane scope), no writes to staging/production, nothing merged or deployed by Kiro.

## 1. Pick up existing lanes (claim first: `queue.mjs claim <slug>/<lane> --session <id> --repo <repo>`)
- [ ] `new-member-welcome/team-welcome-backend` — review vitana-platform#4133 against the lane's acceptance, re-check `drift` after the migration applies
- [ ] `new-member-welcome/new-member-card-optin`, `grouped-welcome-notifications`, then `say-hello-composer`
- [ ] `multi-tenant/provisioning-ui` (seat hotmail)
- [ ] `pm-agent/p2-registry`, `p6-board` (exafyltd → jtadic); `p3-observe-decide`, `p4-act` (jtadic → exafyltd)
- [ ] `health-native/d10-wp3-enforcement`, `n5a-health-sync`, `n6b-ios-voice` (see `.kiro/specs/health-native/tasks.md`)
- [ ] `life-timeline/p1…p6` lane files brought up to date (one lane-state transition per PR)

## 2. Plans to write (`plan(<slug>)` PR → CI sparring → policy approval) — see `handoff.md` §2 for the full table and what each waits on
- [ ] P1 onboarding-coach has-listened fix
- [ ] P2 calendar shared events, Invites Phase 2 (re-create the sparring record first)
- [ ] P3 health agentic system S0-A / S0-B (re-spar through CI)
- [ ] P4 Loop Engineering Phase 6
- [ ] P5 Spotlight failing suites + `I18N-PROPAGATE` stale-write bug
- [ ] P6 pre-existing failing full-staging specs
- [ ] P7 staging-verify reliability (75-minute limit, superseded runs)
- [ ] P8 FCM via task-role token; `wallet_balances` → `user_wallets`
- [ ] P9 email-backup reminders, Firebase wiring, Resend switch-on
- [ ] P10 concert tour: signup source attribution, then Tour Pass
- [ ] P11 notification-tap speed-ups (web side)
- [ ] P12 lock-screen push, base-image mirror
- [ ] P13 news-feed fix #1252 (needs a valid ledger row first)
- [ ] P14 Maxina intro French layout (check `main` first)
- [ ] P15 Appilix native share, probe removal, plugin 1.0.1
- [ ] P16 native Wave 2 / EAS / Health Hub phases (see health-native)
- [ ] P17 What's New card for contact import
- [ ] P18 timeline entry "Open" links

## 3. Read-only checks (log the result in the PR or lane log; do not change anything)
- [ ] 758173b live in production? `mentions-everywhere` published 2026-10-09?
- [ ] Why did production `build-info` read `db009b53`?
- [ ] `claim_routine_run` / `finish_routine_run` present in the prod database?
- [ ] Community-app STAGING-VERIFY run 38380755924 and newer; Gate 2 evidence for VTID-05133
- [ ] Jev shadow rows after the owner's voice test
- [ ] Staging redeploy of `main` finished (Live Room card)
- [ ] CI state of vitana-platform#3963 and vitana-v1#1252

## 4. Not for Kiro — Claude Code / Project Manager / owner (see `handoff.md` §4)
- [ ] Reconcile and send one Gate 2 per service; merges; production dispatches; migrations; EventBridge, IAM, Google Cloud and Appilix steps; production data writes
