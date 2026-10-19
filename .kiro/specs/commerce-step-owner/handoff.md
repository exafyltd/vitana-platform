---
slug: commerce-step-owner
author: kiro
author_seat: jtadic
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-10-19T13:25Z
---
# Handoff — commerce-step-owner

Follow-up 2 of VTID-05204. Every open onboarding step says who can finish it (the supplier's AI assistant, the
supplier, or Vitanaland), in the onboarding status and the Commerce MCP status; the supplier screen's "Still needed"
groups the open steps the same way.

Plan: `plan.md`. Requirements and tasks are alongside.

Lanes:
- `gateway-step-owner` (vitana-platform): seat `exafy`, reviewer `exafyltd`.
- `frontend-still-needed` (vitana-v1): seat `exafyltd`, reviewer `exafy`; after `gateway-step-owner`.

## Log

### 2026-10-19T13:25Z · kiro-jtadic-202610191323-d24a · drafted
Owner instruction 2026-10-19 ("yes, go ahead") after the Commerce onboarding audit, gap C1. Authored from the code
at vitana-platform@3cbe82e4c and vitana-v1@704b5def4 (file:line in `plan.md`). Pushed as a `plan(` PR for
PLAN-SPAR. No VTID allocated, no product code changed, no live system touched. Next: PLAN-SPAR spars it; seat
`jtadic` answers each round in `sparring/responses-<n>.md`.
