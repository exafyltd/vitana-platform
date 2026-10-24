# Sparring round 1 — in_progress

Session: `89b36d49-f10d-4101-a12c-a5011b92ac29` · plan hash `f156730ab5bb404ce9f1261f91aed18a0ebc376310b5202d2c47d0127d28cae9`

## Summary

The sparring session was pinned exclusively to `exafyltd/vitana-platform@84fc0ca6a0d116f4e41dfd77c5125cb329b95f15`. Every file the plan makes technical claims about — `apps/mobile/parity/ledger.json`, `src/App.tsx`, `scripts/native/parity-scope.json`, `packages/core/manifest.json`, `src/lib/horizonBuckets.ts`, `src/lib/vitana-projection.ts`, `src/navigation/registry/exclusions.json` — lives in `exafyltd/vitana-v1`. All read attempts against vitana-platform for plan-referenced paths returned 404. `list_dir` on vitana-v1 returned "no pinned ref for exafyltd/vitana-v1 in this session". The plan's own sibling (`native-wave2-home-feed-news`) explicitly names vitana-v1 as its repo, and the `plan-spar-vitana-v1-ref` spec documents this exact failure mode verbatim: "Any finding about the frontend half is made blind, and the partner's evidence rule cannot be met for vitana-v1." This is a complete-blind session: zero premises can be verified or refuted on the merits. Two findings are raised; the plan must not converge.

## Findings

### R1-F1 [blocker]

No `exafyltd/vitana-v1` ref was forwarded to this sparring session. The session prompt names only `exafyltd/vitana-platform@84fc0ca6` as the pinned ref. Every file the plan references — `apps/mobile/parity/ledger.json`, `src/App.tsx`, `src/pages/AutopilotDashboard.tsx`, `lib/horizonBuckets.ts`, `lib/vitana-projection.ts`, `packages/core/manifest.json`, `scripts/native/parity-scope.json`, `src/navigation/registry/exclusions.json`, `apps/mobile/app/(app)/[...path].tsx` — lives in vitana-v1, as confirmed by the sibling plan `native-wave2-home-feed-news`, which opens with 'Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**` via the manifest/closure process, `apps/mobile/parity/ledger.json`...)'. The `plan-spar-vitana-v1-ref` spec records this exact failure mode: 'the gateway pins the partner's read_file/list_dir tools to input.repo at input.base_ref only. Any finding about the frontend half is made blind, and the partner's evidence rule (every finding cites a file it read) cannot be met for vitana-v1.' The sibling plan's Re-spar note (lines 131–138) documents that its first sparring session was escalated for exactly this reason and required a re-run after PR #4201 fixed PLAN-SPAR.yml to forward `--extra-ref-vitana-v1`. This plan is in the same state. Consequently none of the plan's load-bearing premises can be assessed: the IO-free classification of `horizonBuckets.ts`/`vitana-projection.ts` (called 'load-bearing' by the plan itself), the 2-row/435-row ledger count, the `App.tsx:1538-1548` routes, the `packages/core/manifest.json:59` autopilot-type re-export, the `exclusions.json:211` audiobook row, the Wave 1 VTID shell assertions, and all parity-scope.json line references are unverifiable. The plan must not converge in this state.

- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:1` — Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; no
backend, no gateway change, no migration).
- `exafyltd/vitana-platform:.kiro/specs/plan-spar-vitana-v1-ref/plan.md:13` — The CI sparring client
(`scripts/collab/plan-spar.mjs`, `step()`) calls `client.create({ plan_text, producer, change_class,
base_ref, repo, approval_policy })` with **no `extra_refs`** (the only `client.create`, at
`plan-spar.mjs:192–195`), so the gateway pins the partner's `read_file`/`list_dir` tools to
`input.repo` at `input.base_ref` only. Any finding about the frontend half is made blind, and the
partner's evidence rule (every finding cites a file it read) cannot be met for `vitana-v1`.
- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:131` — The first sparring session (`759e1c03`) escalated on infrastructure (the pipeline was being fixed — code
access, Bedrock subscription, daily-token cap, and the vitana-v1 ref). Those are all resolved now: the
vitana-v1 ref fix is merged to main (PR #4201, `fa73aabd0`), so `PLAN-SPAR` forwards
`extra_refs: { 'exafyltd/vitana-v1': <sha> }` and a session created from this branch (which now has the fix
in its base, main merged in) can read `exafyltd/vitana-v1` to verify this plan's `apps/mobile/**` and web
screen premises.
- `exafyltd/vitana-platform:.kiro/specs/plan-spar-vitana-v1-ref/plan.md:37` — VTID-05215 already landed a narrower mechanism on `main`: `PLAN-SPAR.yml` resolves `vitana-v1`'s
`main` HEAD (`gh api repos/exafyltd/vitana-v1/commits/main --jq .sha`) and passes it as a single
`--extra-ref-vitana-v1 <sha>` CLI arg, which `plan-spar.mjs` forwards as `extra_refs`. That pins
`vitana-v1@main` for **every** plan PR

Suggestion: Diagnose why VTID-05215's `--extra-ref-vitana-v1` mechanism failed to produce a vitana-v1 pin for this session despite the fix being on main at the pinned commit. To eliminate ambiguity for the re-run, add a `spar_refs:` block to the plan's `handoff.md` declaring the exact 40-hex vitana-v1 SHA (as the `plan-spar-vitana-v1-ref` design supports), so the sparring partner is guaranteed access to both repos. Only then re-trigger sparring. No convergence or policy approval should be issued from this session.

### R1-F2 [major]

The plan's entire core-extraction strategy rests on a premise explicitly called 'load-bearing' — that `horizonBuckets.ts` and `vitana-projection.ts` are IO-free (class A) — and states this was 'confirmed at the pinned commit'. That confirmation cannot be verified in this session because vitana-v1 is inaccessible. The identical risk materialised for the sibling plan: `native-wave2-home-feed-news` discovered during sparring that `post-attachment.ts` has a runtime import of `@/integrations/supabase/client` which would have pulled a class-B module into the core BFS and failed `core-closure --check`. If either autopilot helper has any runtime import of `@/integrations/supabase/client` or `@/lib/community-gateway`, the journey-lane PR will fail the NATIVE-CI `--check` gate after implementation is complete. A second unverified companion claim — that `packages/core/manifest.json:59` already holds the `src/types/autopilot.ts` type re-export — is also load-bearing: if absent, every `autopilot-audiobook`-lane type import from core fails to compile.

- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:56` — That matters: giving them a core entry would pull them into the
`core-closure.mjs` BFS, where their *runtime* imports (`matchReason.ts:1` → `@/lib/i18n-toast`; `post-attachment.ts:11`
→ `@/integrations/supabase/client.ts`, a class-B module with `import.meta.env` / `localStorage` / the prod Supabase
URL) make `core-closure --check` fail (`core-closure.mjs:150`, `m.own !== 'A'`).
- `exafyltd/vitana-platform:.kiro/specs/plan-spar-vitana-v1-ref/plan.md:13` — the gateway pins the partner's `read_file`/`list_dir` tools to
`input.repo` at `input.base_ref` only. Any finding about the frontend half is made blind, and the
partner's evidence rule (every finding cites a file it read) cannot be met for `vitana-v1`.

Suggestion: Once R1-F1 is resolved and vitana-v1 is accessible, the sparring partner must read `src/lib/horizonBuckets.ts` and `src/lib/vitana-projection.ts` in their entirety to confirm no runtime import of `@/integrations/supabase/client` or `@/lib/community-gateway` is present. It must also read `packages/core/manifest.json` around line 59 to confirm the `autopilot.ts` type re-export entry exists. Both checks must appear in the sparring evidence before the plan can converge.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
