---
lane: whats-new-golden-regen
state: ready
next_actor: claude
depends_on: []
executor: claude
reviewer_seat: jtadic
paths:
  - services/gateway/test/golden/v1-golden-edge.*
updated: 2026-10-15T18:40Z
---
# whats-new-golden-regen — regenerate v1-golden-edge after the neutral drafter prompt (repo vitana-platform)

Plan: `.kiro/specs/mt-packs/plan.md` (authoritative) and the `whats-new-golden-regen` section of `tasks.md`
(W2, allowed paths, acceptance). Design + successor rules: `design.md`.

**CROSS-SPEC O3:** regenerate mt-guardrails' `v1-golden-edge` fixture as a declared, reviewed golden update that
reflects the brand-neutral drafter prompt from `whats-new-drafter-prompt` (vitana-v1). mt-guardrails is the
fixture owner: it places `v1-golden-edge.*` under `services/gateway/test/golden/**` and documents a regenerate
script in `scripts/mt/golden/` (mt-guardrails `maxina-golden-suite` M3). This lane regenerates the fixture by
running that documented script — it does NOT define a second fixture location or hand-edit the file — and the
regenerated fixture must make mt-guardrails' golden suite (`mt-maxina-golden.test.ts`) pass. The regeneration is
scoped to exactly `services/gateway/test/golden/v1-golden-edge.*`; the `scripts/mt/golden/` script itself is
owned by mt-guardrails and is not edited here. This lane adds its own `docs/validation/<vtid>/`.

**Governance / cross-spec coordination → `executor: claude`.** The fixture is owned by mt-guardrails, so Claude
Code carries the O3 coordination (the two specs must not both rewrite the fixture independently); `next_actor:
claude` (not owner-held). Reviewer seat is a Kiro seat (`jtadic`).

**Cross-repo ordering (reference, not a `depends_on` id — that field takes in-spec lane ids only):** this lane
runs after `whats-new-drafter-prompt` (vitana-v1) so the regenerated golden reflects the neutral copy, and after
mt-guardrails' `maxina-golden-suite` exists (it creates `v1-golden-edge.*` and the regenerate script).

Rules (collaboration §7a, applied to Claude as the executor): no VTID allocation (PLAN-SPAR allocates), no
`_plan` claim, no edit of `handoff.md`, no merge/approve of its own PR, no Supabase/AWS write, no workflow
dispatch/deploy. Work only inside the allowed path. Branch `claude/mt-packs/whats-new-golden-regen`; PR title
`VTID-xxxxx (mt-packs/whats-new-golden-regen): …`; trailers `Collab-Session: <id>` /
`Collab-Lane: mt-packs/whats-new-golden-regen`.

## Log
### 2026-10-15T18:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created from the split of the former `whats-new-drafter` lane (internal-review HIGH-2: never merge across repos;
HIGH-3: fixture lives at `services/gateway/test/golden/v1-golden-edge.*`, matching mt-guardrails
`maxina-golden-suite`, not `test/fixtures/`). Carries CROSS-SPEC O3. Governance/cross-spec coordination →
`executor: claude`, `next_actor: claude`, no seat, reviewer `jtadic`.
