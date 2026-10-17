---
lane: maxina-golden-suite
state: ready
next_actor: owner
executor: kiro
seat: jtadic
reviewer_seat: exafyltd
depends_on: []
paths:
  - services/gateway/test/mt-maxina-golden.test.ts
  - services/gateway/test/golden/**
  - scripts/mt/golden/**
updated: 2026-10-16T21:44Z
---
# Maxina golden suite + v1-golden-edge fixture — mt-guardrails/maxina-golden-suite (repo vitana-platform)

Plan: `.kiro/specs/mt-guardrails/plan.md` (authoritative) and the `maxina-golden-suite` section of
`tasks.md` (M1–M3, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

`next_actor: owner` is HELD: it flips to `kiro` when PLAN-SPAR allocates this lane's VTID. No lane
dependency (it renders Maxina config, independent of the stack lanes).

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`, no merge/approve/deploy/workflow dispatch, no live-system writes. **Never capture or
compare spoken output (rule 41)** — compare facts/intents and non-speech UI/push/email strings only. This
lane OWNS `golden/v1-golden-edge.*`; mt-packs P4 regenerates it as a declared, reviewed golden update
(CROSS-SPEC O3) through the documented regenerate script, never a silent diff. Keep `test:support`/
`test:operator`/`test:roles` green. Work only inside the allowed paths; add this lane's own
`docs/validation/<vtid>/`.

Branch `kiro/mt-guardrails/maxina-golden-suite`; PR title `VTID-xxxxx
(mt-guardrails/maxina-golden-suite): …`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-guardrails/maxina-golden-suite`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-16T21:44Z · kiro-hotmail-202610151618-b437 · created → ready
Created from the WS0 plan. Pins Maxina's assembled instruction/intents + UI/push/email strings
byte-for-byte so later tenancy work cannot drift Maxina. Owns the `v1-golden-edge` fixture (O3). Held at
`next_actor: owner` until the VTID is allocated.
