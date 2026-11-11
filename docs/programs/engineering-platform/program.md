---
id: engineering-platform
title: Engineering platform — self-hosted GitLab on AWS for governed agent delivery
status: active
priority: 3
repos: [vitana-platform, vitana-v1]
specs:
  - vitana-platform:eng-platform-p01
  - vitana-platform:eng-gitlab-m1
  - vitana-platform:eng-gitlab-m2
  - vitana-platform:agentic-delivery
  - vitana-platform:agentic-delivery-v2
  - vitana-platform:claude-migration-lanes
  - vitana-platform:agentic-delivery-scope
docs:
  - vitana-platform:docs/ENGINEERING-PLATFORM-PLAN.md
exit_criteria:
  - Acceptance criteria A01-A34 of docs/ENGINEERING-PLATFORM-PLAN.md are demonstrated
  - Both repos have GitLab as source of truth and GitHub is archived or read-only
next_review: 2026-11-16
---
# Engineering platform

Programme registry entry. Links only; the plan is the source of truth.

- Plan: `vitana-platform:docs/ENGINEERING-PLATFORM-PLAN.md` (written by lane `eng-platform-p01/program-doc`)
- Spec: `vitana-platform:.kiro/specs/eng-platform-p01/` (Phase 0 inventory + Phase 1 keyless staging CI)
- Spec: `vitana-platform:.kiro/specs/eng-gitlab-m1/` (self-hosted GitLab, milestone 1: the running system under review, tests, restore check)
- Spec: `vitana-platform:.kiro/specs/eng-gitlab-m2/` (GitLab on the Free tier, ready for many agents: runner fleet, agent logins, merge bot, gateway route, alarms, rehearsal)
- Spec: `vitana-platform:.kiro/specs/agentic-delivery/` (milestone 3: hard cutover of delivery for both repositories to GitLab)
- Spec: `vitana-platform:.kiro/specs/agentic-delivery-v2/` (one delivery flow for 13 parallel executors on autopilot to STAGING-VERIFY: VTIDs from CI, Bedrock review and sparring responder, seats, Phase 0)
- Spec: `vitana-platform:.kiro/specs/agentic-delivery-scope/` (owner spec v5: machine gates, traceability, retries, vision and staging checks, address cleanup; reuses the agentic-delivery-v2 lanes)
