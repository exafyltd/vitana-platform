# Audiobook voice rebuild Phase 1 (session_019nAbKEye1ewjSuFeh8vR15)
- Created 2026-10-08 22:40 / updated 2026-10-13 20:18 UTC; status idle (bucket blocked). Branch `ccr-103160a8-tvu0zm` in both repos (pushed on 10-13, equals main, 78 commits already on main).
## Goal
Rebuild audiobook narration voices: Russian and Serbian by Google Cloud TTS (Chirp 3 HD Aoede), the other six languages by Polly generative (VTID-05026).
## Done
- VTID-05026 live in production and closed in the ledger (2026-10-10 14:40 UTC). Prod deploy run 403 (env-only) set `GOOGLE_AUTH_AWS_SUPPLIER_ENABLED=true`, `AUDIOBOOK_GOOGLE_RU_ENABLED=true`, `AUDIOBOOK_GOOGLE_SR_ENABLED=true`, cap 1,040,000 chars/task/day; task definition 179 then; 195 on 10-13 with prod commit db009b53. Log showed `access token prewarmed (auth=aws_supplier)`; /alive 200.
- PR numbers for VTID-05026 not seen.
- 10-13 read-only log check: Appilix pushes working, `live_room_get_state` 0 errors in 24h. No member has played a ru/sr audiobook yet.
## State now
- No open PRs seen. Reminder for the Google credit-window review fires 2026-12-06 (the 90-day window ends about 2026-12-16).
## Blocked on / needs owner
- FCM pushes fail (`app/invalid-credential`): owner chose option (a). Run the grant script in Google Cloud Shell as Owner of `lovable-vitana-vers1` (not AWS): grants `roles/firebasecloudmessaging.admin` to SA `vitanaland@project-da3eb05a-c86e-47cb-85f.iam.gserviceaccount.com`, enables fcm.googleapis.com if needed; paste output. Session's identity is denied (403 cloudmessaging.messages.create), so it cannot do this itself. Stop if project lifecycle is not ACTIVE or API enable fails (billing off).
- Run `scripts/aws/setup-audiobook-google-metric.sh --apply` in AWS CloudShell (cost alarm has no metric data).
- `wallet_balances` decision (table missing; recommendation: read from canonical `user_wallets`, VTID-04809); owner must say "go" to spar a plan.
## Next steps for Kiro
1. After grant output: verify with the dry-run FCM call (validate_only), then write the plan: `notification-service.ts:30-33` use the task-role token module instead of `applicationDefault()`, projectId stays `lovable-vitana-vers1`; spar via `plan(` PR.
2. If owner says go: plan for wallet_balances readers (6 gateway files) to use `user_wallets`.
3. Claude-Code/owner only: the Google Cloud grant and CloudShell scripts, prod deploys, Gate 1/2.
## Gotchas/lessons
- `lovable-vitana-vers1` is the decommissioned GCP project; reaching into it for FCM is an owner-level exception, only one role to one SA.
- Google voices are only for ru/sr; failed/capped render answers 422, never another voice.
