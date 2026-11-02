---
slug: mt-network-r2
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-01T15:56Z
---
# Handoff — mt-network-r2
Re-plan of `mt-network` (branch `kiro/mt-network/plan`). Its PLAN-SPAR session `0f65161a` stopped at round 2 with no
answer. The spec covers the WS3 Network half:
- `send_message`/`send_message_as` and `chat_messages.scope`;
- opt-in `network_visible`;
- legacy message migration;
- intent/daily-match scope;
- ORB recipient scope;
- Network groups.
Plan: `plan.md`.

## Log

### 2026-11-01T15:56Z · kiro-hotmail-202611011452-6d16 · drafted
Owner instruction 2026-11-01: re-plan the stuck plans under new slugs ("you make the decisions for me"). The findings
are answered on their actual content in `plan.md` "Re-plan answers":
- R1-F1: one migration tree, vitana-platform, for all DB lanes.
- R1-F4/R2-F1: the premise is false on `main`. The catch-all policies were dropped by `20260608120000`. The plan
  asserts they stay gone and bounds service-role writes in code.
- R2-F2: a `.from()` writer lint covering 11 sites.

Other changes:
- Lane paths are fixed to the real files.
- Lanes that share files are sequenced.
- Slots are day-shifted to `20261102050*`.
- Every lane is `executor: kiro`, reviewed by the reviewer agent.
- Migrations are applied only on the owner's approval (§7d).

The plan PR opens when PLAN-SPAR capacity allows (`collaboration.md` §8a).
