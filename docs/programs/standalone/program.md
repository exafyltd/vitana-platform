---
id: standalone
title: Standalone work (specs outside the named programmes)
status: active
priority: 3
repos: [vitana-platform, vitana-v1]
specs:
  - vitana-platform:pm-agent
  - vitana-platform:claude-sessions-handover
  - vitana-platform:retire-claude-code
  - vitana-platform:plan-spar-stale-session
  - vitana-platform:fix-4182-test-fallout
  - vitana-platform:collab-queue-perf
  - vitana-v1:chat-ux
  - vitana-v1:vitana-chat-markdown
  - vitana-platform:collab-multi-builder-handoff
  - vitana-platform:collab-kiro-governance
  - vitana-platform:kiro-primary-executor
  - vitana-platform:kiro-autonomy-fallback
  - vitana-platform:kaf-fallback-env
  - vitana-platform:claude-md-cleanup
  - vitana-platform:messenger-ux-v2
  - vitana-platform:ci-github-modernization
  - vitana-platform:ci-ecr-public-auth
  - vitana-platform:matches-scroll-end
  - vitana-platform:profile-posts-full-width
  - vitana-platform:staging-verify-runner-fix
  - vitana-platform:reviewer-model-fallback
  - vitana-platform:i18n-audit-nightly-off
  - vitana-platform:pipeline-speed
  - vitana-platform:reviewer-step-model
docs:
  - vitana-platform:.kiro/specs/pm-agent/plan-sparring.md
  - vitana-platform:.kiro/specs/claude-sessions-handover/handoff.md
  - vitana-v1:.kiro/specs/chat-ux/plan-sparring.md
  - vitana-v1:docs/validation/VTID-05193/plan-sparring.md
exit_criteria:
  - Every spec listed here is done or has moved to a named programme
next_review: 2026-10-22
---
# Standalone work

Programme registry entry (VTID-05215). Every current `.kiro/specs/*` spec belongs to exactly one programme; specs that
belong to none of the named programmes are listed here until the owner assigns them to one. Links only.

- `vitana-platform:pm-agent` — Project Manager Agent
- `vitana-platform:claude-sessions-handover` — handover of ongoing Claude Code sessions to Kiro
- `vitana-platform:plan-spar-stale-session` — PLAN-SPAR re-runs dead in_progress sparring sessions
- `vitana-platform:fix-4182-test-fallout` — staging suite + Jest pin left stale by #4182 (VTID-05082)
- `vitana-platform:collab-queue-perf` — collab queue reads git in a constant number of processes
- `vitana-v1:chat-ux` — chat UX
- `vitana-v1:vitana-chat-markdown` — Vitana chat replies render Markdown
- `vitana-platform:messenger-ux-v2` — Messenger: reliable sending, scroll, replies, media, search, sharing, push suppression
- `vitana-platform:kiro-autonomy-fallback` — Claude Code optional; Kiro runs the pipeline end to end
- `vitana-platform:kaf-fallback-env` — fix-forward: the staging PM sees Kiro-fallback mode (VTID-05277)
- `vitana-platform:claude-md-cleanup` — trim CLAUDE.md to project-specific rules (both repos)
- `vitana-platform:ci-github-modernization` — modernize CI/GitHub for both repos (dead removal, false-positive fixes, speed, CI-health)
- `vitana-platform:ci-ecr-public-auth` — authenticated public.ecr.aws base-image pulls in stage/prod image builds (both repos)
- `vitana-platform:matches-scroll-end` — the phone Matches list (`/me/matches`) scrolls to its last card (vitana-v1)
- `vitana-platform:profile-posts-full-width` — profile Posts tab: avatar header on top, post text/media full width (vitana-v1)
- `vitana-platform:staging-verify-runner-fix` — STAGING-VERIFY: pinned runner image, native suite commands, bundle profile (both repos)
- `vitana-platform:reviewer-model-fallback` — retroactive spar + VTID + read-only staging coverage for the reviewer-agent three-model fallback chain merged in #4295
- `vitana-platform:pipeline-speed` — Kiro pipeline time-to-completion: zero-cost empty slots, one-pass preflight, restart watchdog
- `vitana-platform:reviewer-step-model` — every pinned review step's prompt opens with its own chain model, so the reviewer agent's self-check stops returning `model_unavailable`
