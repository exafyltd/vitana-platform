# Ordinary staging path, read-only, 2026-11-19T13:58Z (account 472838866351, eu-central-1, role kiro-agent-role)
Nothing was changed. No secret value was read.

| Question | Answer | Source |
|---|---|---|
| Gateway the staging app is built against | `https://preview-aws-gateway.vitanaland.com` (`VITE_GATEWAY_URL=<that>/api/v1`) | vitana-v1 `AWS-STAGE-DEPLOY-FRONTEND.yml:102,133` |
| Who serves `/api/v1/*` on that host | ALB rule 9 → `vitana-tg-gateway-preview` (healthy) → `vitana-gateway-preview:2`, 1/1 | `describe-rules`, `describe-target-health`, `describe-services` |
| Ordinary staging gateway | `vitana-gateway` 0/0 on `:1025`; rule 10 target group `vitana-tg-gateway-prod` unhealthy | same |
| Ordinary staging gateway deploy | last 3 `AWS-STAGE-DEPLOY-GATEWAY` runs failed (44507564289: `vitana/supabase/staging/jwt-secret` not found); handled by VTID-05803 / #5116 | KIRO 12 on #5116 |
| Staging frontend (`preview-aws.vitanaland.com`) | ALB rule 30 → `vitana-tg-community-prod`, **no registered targets**; service `vitana-community-app-staging` 0/0 on `vitana-community-app:533` since 2026-11-16T13:48:49Z (`UpdateService desiredCount=0`, `j.tadic@vitanaland.com`) | `describe-services`, CloudTrail |
| Would the ordinary frontend deploy bring it back | No: the update branch of the deploy step registers a new task definition but sets no desired count, so the service stays at 0 | `AWS-STAGE-DEPLOY-FRONTEND.yml` (`--desired-count 1` only on create, line 237) |
| Last frontend staging deploys | 2026-11-13 and 2026-11-14 failed only at "Trigger STAGING-VERIFY" (GitHub API rate limit) | runs 43483466398-ish (447e46a82), 43569823868 |
| STAGING-VERIFY community-app | last runs 2026-11-14 failure, 11-14 / 11-15 / 11-16 cancelled; with no frontend target it cannot pass today | STAGING-VERIFY run list |

**Verdict: not ready.** A frontend merge now would deploy a task definition to a service at 0 tasks, and STAGING-VERIFY
would test a host with no targets. The decision to bring `vitana-community-app-staging` back (and in what shape) is the
operator's or the owner's; Kiro does not scale it.
