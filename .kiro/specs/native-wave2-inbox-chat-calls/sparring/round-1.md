# Sparring round 1 — in_progress

Session: `f9549fe4-3a26-439f-b09e-c9c017660e49` · plan hash `6b3cfd0ddcdfc2f1a02ec148919a5ccaf97c4e2d9eab3b814e03e0c9837ec9aa`

## Summary

This plan cannot be properly sparred in its current form. The plan references all its code premises against `exafyltd/vitana-v1` (the native app + web source repo), but the sparring session is pinned only to `exafyltd/vitana-platform`. The vitana-v1 repo has no pinned ref in this session — `list_dir` returns "no pinned ref", `search` returns no hits or 403, and `read_file` is unavailable. This means none of the plan's ~15 distinct factual premises about existing code (ledger rows, web source files, hook classifications, route lines, call embedding locations, parity-ledger.mjs matching logic) can be verified against actual source. The predecessor wave 2 plan (home-feed-news) explicitly declared "Repo: `exafyltd/vitana-v1`" and a ref-forwarding fix (VTID-05253, PR #4201) was supposedly merged to make vitana-v1 readable in sparring — but it is not working for this session. Until the vitana-v1 ref is forwarded and the plan's code premises can be checked, approving this plan would violate the sparring contract (every factual statement must be verified).

## Findings

### R1-F1 [blocker]

The plan's code premises are entirely unverifiable because vitana-v1 is not accessible in this sparring session. Every file the plan references — `apps/mobile/parity/ledger.json`, `src/pages/Messages.tsx`, `src/components/CallManager.tsx`, `src/hooks/useWebRTC.ts`, `src/App.tsx`, `scripts/native/parity-ledger.mjs`, and ~10 other files — lives in `exafyltd/vitana-v1`, but the session is pinned only to `exafyltd/vitana-platform`. The predecessor wave 2 plan explicitly declared 'Repo: exafyltd/vitana-v1' (home-feed-news/plan.md line 2) and a ref-forwarding fix (VTID-05253) was merged to enable vitana-v1 access in sparring, but it is not functioning for this session. This means no premise — the 9 ledger rows, the lane partition, the class-B hook classifications, the CallProvider embedding location, the shapeOf matching logic, the route lines — can be verified against source code. Approving an unverified plan violates the sparring contract.

- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:1` — # Plan — native-wave2-home-feed-news
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; no
backend, no gateway change, no migration).
- `exafyltd/vitana-platform:docs/validation/VTID-05253/vitana-v1-spar-evidence.md:6` — **The ref fix is merged** (PR #4201, `fa73aabd0`): `scripts/collab/plan-spar.mjs` forwards
`extra_refs: { 'exafyltd/vitana-v1': <sha> }` and `.github/workflows/PLAN-SPAR.yml` resolves the vitana-v1
`main` SHA, so any future native plan spars with vitana-v1 readable...

**Honest limitation.** The session that actually *converged* this plan (`8e2ff780`) was created before the
ref fix was in the plan branch's base checkout, so in that converging round the sparring partner could not
`read_file` vitana-v1.

Suggestion: Fix the sparring session configuration so that `exafyltd/vitana-v1` is pinned (via the `extra_refs` mechanism in `scripts/collab/plan-spar.mjs` / `.github/workflows/PLAN-SPAR.yml`). Re-run the sparring round once vitana-v1 is readable. Until then, no code premise can be verified and the plan cannot be approved.

### R1-F2 [major]

The plan does not declare its target repo. The predecessor wave 2 plan (home-feed-news) explicitly states 'Repo: exafyltd/vitana-v1' in its header (line 2), establishing that native wave 2 plans operate on vitana-v1. This plan omits the repo declaration entirely, making it ambiguous which codebase the premises and file paths refer to. This is not just a documentation gap — the sparring infrastructure uses the repo declaration to pin the correct ref.

- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:1` — # Plan — native-wave2-home-feed-news
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; no
backend, no gateway change, no migration). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this
folder.

Suggestion: Add a header line to the plan: 'Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, ...)' matching the predecessor plan's format. This ensures the sparring infrastructure pins vitana-v1 and the reviewer knows which codebase to verify against.

### R1-F3 [major]

The plan states the embedded 1:1 WebRTC calling is at 'Messages.tsx:52-53,1227-1569' (CallProvider + CallManager), that the file is 1571 lines, and that chat/call hooks are all class B (importing @/integrations/supabase/client.ts). These are load-bearing premises for the core purity rule (Decision 2) and the lane partition (Decision 1 — calls ride with conversation-chat because they're embedded in the conversation surface). None of these can be verified because vitana-v1 is not accessible. If CallManager is NOT mounted inside Messages.tsx, or if some hooks are actually class A (pure), the lane split and the core extraction decision could be wrong.

- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:53` — Only the pure IO-free compose/rank modules move into `@vitana/core`; the data-fetching hooks do NOT... The **feed hooks `useNewsFeed`/`useAllNewsFeed` are NOT moved into core** either — they runtime-import `supabase/client.ts` (`useAllNewsFeed.ts:18`, `useNewsFeed.ts:10`) and would fail the same closure gate
- `exafyltd/vitana-platform:docs/validation/VTID-05253/vitana-v1-spar-evidence.md:18` — **What satisfies the gate instead (the stronger, practical form).** Every implementation lane behind this sentinel was built and reviewed against the real vitana-v1 code

Suggestion: These premises must be verified against vitana-v1 source once the ref is available. Specifically: (1) confirm CallProvider/CallManager mount location in Messages.tsx, (2) confirm every listed chat/call hook imports @/integrations/supabase/client.ts at runtime (not just type-only), (3) confirm no chat/call utility is accidentally class A and should be a core candidate.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
