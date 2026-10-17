---
lane: whats-new-drafter-prompt
state: ready
next_actor: claude
depends_on: []
executor: claude
reviewer_seat: jtadic
paths:
  - .github/workflows/WHATS-NEW-DRAFT.yml
updated: 2026-10-15T18:40Z
---
# whats-new-drafter-prompt — brand-neutral drafter prompt (repo vitana-v1)

Plan: `.kiro/specs/mt-packs/plan.md` (authoritative) and the `whats-new-drafter-prompt` section of `tasks.md`
(W1, allowed paths, acceptance). Design + successor rules: `design.md`. **Repo vitana-v1.**

Make the What's New drafter prompt brand-neutral in `.github/workflows/WHATS-NEW-DRAFT.yml`. That workflow lives
ONLY in vitana-v1 (`c:\Users\dstev\vitana-v1\.github\workflows\WHATS-NEW-DRAFT.yml`; vitana-v1 `CLAUDE.md` §"What's
New" describes it as that repo's post-merge drafter) — it does not exist in vitana-platform, so this lane is a
vitana-v1 change. The drafter copy drops the hardcoded brand name so a drafted entry reads brand-neutral; the
`{{brand}}` layer (brand-content-templating / frontend-brand-neutralise) supplies the tenant brand at render time.
This lane adds its own `docs/validation/<vtid>/` (in vitana-v1).

**Governance path → `executor: claude`** (`.github/**` is a governance path in vitana-v1 too, collaboration
§3a/§7): built by Claude Code, not Kiro, so `next_actor: claude` (not owner-held). Reviewer seat is a Kiro seat
(`jtadic`).

**CROSS-SPEC O3:** the golden-fixture regeneration that O3 ties to the drafter-prompt change lives in the
separate `whats-new-golden-regen` lane (repo vitana-platform) — one lane is one branch = one PR in one repo, and
the collaboration CROSS-SPEC "Lane count" rule forbids merging across repos, so the vitana-v1 prompt change and
the vitana-platform fixture regen cannot share a lane. The ordering is a stated cross-repo reference (the
in-spec `depends_on` field only takes lane ids): `whats-new-golden-regen` regenerates the fixture after this
prompt change so the golden reflects the neutral copy.

Rules (collaboration §7a, applied to Claude as the executor): no VTID allocation (PLAN-SPAR allocates), no
`_plan` claim, no edit of `handoff.md`, no merge/approve of its own PR, no workflow dispatch/deploy. Branch
`claude/mt-packs/whats-new-drafter-prompt`; PR title `VTID-xxxxx (mt-packs/whats-new-drafter-prompt): …`;
trailers `Collab-Session: <id>` / `Collab-Lane: mt-packs/whats-new-drafter-prompt`.

## Log
### 2026-10-15T16:18Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-packs planner (originally as the vitana-platform lane `whats-new-drafter`).

### 2026-10-15T18:40Z · kiro-hotmail-202610151618-b437 · internal-review fix
Split the former `whats-new-drafter` lane: the drafter-prompt change is a vitana-v1 workflow edit (HIGH-1:
`WHATS-NEW-DRAFT.yml` exists only in vitana-v1), separated from the vitana-platform golden regen (HIGH-2: never
merge across repos → `whats-new-golden-regen`). Governance-path lane (`.github/**`) → `executor: claude`,
`next_actor: claude`, no seat (collaboration §3a). Reviewer `jtadic`.
