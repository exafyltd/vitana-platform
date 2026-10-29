# Acceptance — VTID-05408 (kiro-lane-admin / lane `enforcement`)

Change types: Tooling/docs, Backend.

The single enforcement point (`scripts/collab/queue.mjs`), its tests, the JSON + compiled-in builtin, and the PM
`governance.ts` mirror now carry the reviewed, auditable Kiro lane-administration mechanism and retire the legacy-claude
protected-gate authority. Design: `.kiro/specs/kiro-lane-admin/design.md` §0–§5, §7; tasks E0–E6.

## Task → change map

| Task | What | Where |
|---|---|---|
| E0 | `const toBool = (v) => v === true \|\| v === 'true';` next to `asList`; used everywhere `lane_admin` is tested (never `=== true`). `parseFrontMatter` yields scalars as strings, so `lane_admin: true` parses to `'true'`. | `queue.mjs` (near `asList`) |
| E1 | `validateLane` recognises the `lane_admin` marker: `toBool(fm.lane_admin)` requires `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer`, and a lane-file path (`.kiro/specs/*/lanes/*.md`); clear error otherwise. `lane_admin` is NOT added to PERM. | `queue.mjs` `validateLane` |
| E1a | `validateRange` gains `fetchPlanLane = null`, threaded from the `validate` CLI exactly as `scope-check` (`--plan-repo` repeatable, else `$GITHUB_REPOSITORY`, else `--lane-repo`). New cross-lane-file exemption before the `:591` error: a changed lane file whose key differs from the commit's `Collab-Lane` passes when `laneAdminCovers(...)` is true. | `queue.mjs` `validateRange` + `validate` CLI |
| E2 | `scopeCheck` TARGET-ONLY PERM carve-out: `selfTrustedLaneAdmin` (via `toBool(trustedFm.lane_admin)`) + `laneAdminCovers(key, lanePath)`; `lane_admin` added to the trusted-pinned set; PERM + governance-path refusals reworded for the Kiro lane-admin / reviewer-agent route; protected-gate refusal (`:699`) and seat-ownership check (`:714-715`) intact. | `queue.mjs` `scopeCheck` |
| E3 | `protected-gate-files.json` `description` + `PROTECTED_GATE_BUILTIN` comment: owner-instruction + reviewer-agent-accept wording (Claude retired); globs byte-identical. | `protected-gate-files.json`, `queue.mjs` |
| E4 | `governanceMergeAllowed` ALWAYS returns `{ok:false, reason:'protected_gate_file'}` for a protected gate file — the legacy-claude programmatic unlock is RETIRED (branch removed); header prose updated; every other verdict unchanged. `isLegacyClaudeReview` kept (still used by the governance-path legacy branch at `:199`). | `governance.ts` |
| E5 | T-A..T-K added to `queue.test.mjs`, each new-behaviour case proven red-on-base (see `red-on-base.log`); all 53 existing cases + the JSON↔builtin parity assertion stay green. | `queue.test.mjs` |
| E6 | Gateway Jest for `governance.ts` updated: legacy-claude no longer unlocks a protected file; a protected file is refused with no review supplied too; every non-protected case unchanged. | `governance.test.ts` |

## Shared helper (one source of truth, §1a/§2)
`laneAdminCovers(repo, base, head, adminLaneKey, targetLaneFile, fetchPlanLane, fetchLane)` is used by BOTH the
`validateRange` exemption and the `scopeCheck` carve-out. It resolves the admin lane's TRUSTED front matter through
`fetchTrustedLaneFm` (merge-base → qualifying `plan(` PR via `fetchPlanLane` → other-repo main via `fetchLane`) — never
the PR head — so `lane_admin`/`executor`/`reviewer_seat` can never be self-granted in the lane PR head.

## Outcome
- An authorized Kiro session (reviewer-agent-gated, trusted-source lane with `lane_admin: true`) can reassign a target
  lane's `seat` and narrow its `paths` (T-B, T-G); an ordinary or self-granting lane still cannot (T-C, T-D, T-H).
- The admin lane can never self-widen its own PERM / `lane_admin` (T-I).
- A protected gate file still cannot merge on a reviewer-agent accept alone — refused by BOTH queue.mjs scope-check
  (T-E) and the PM `governance.ts` (M1, and the new no-review-supplied case); defense-in-depth preserved (R1-F3).
- Seat ownership (T-F), scope checks and independent review are unchanged.
- `lane_admin` compared via `toBool`, never `=== true`; reverting breaks T-J (R2-F1). `fetchPlanLane` threaded into
  `validateRange` so the trusted chain is symmetric with `scopeCheck` (T-K, R2-F2).

## Contract
`scopeCheck` / `validateLane` return shapes unchanged. `governanceMergeAllowed` still returns `{ok:true}` /
`{ok:false, reason}` with the same union. New refusal strings documented in design §4.

## Staging proof
Not verified on staging: developer tooling, no deployed surface (Acceptance "Staging proof" bullet). Proven by
`node --test scripts/collab/queue.test.mjs` (64/64, new T-A..T-K red-on-base captured in `red-on-base.log`) and the
gateway Jest `test/project-manager/governance.test.ts` (43/43). See `commands.log`.

## Bootstrap note (expected governance red)
This lane declares `scripts/collab/queue.mjs` and `scripts/collab/protected-gate-files.json`, which today's rule on
`main` classes as protected gate files. Collab handoff / Lane scope therefore show the OLD governance refusal for those
exact paths from a non-`executor: claude` lane — the very rule this lane repairs (handoff.md / plan.md "Owner
authority"). The lane is `executor: kiro` + `reviewer_seat: agent:vitana-lane-reviewer`; it merges on the owner's
instruction naming the plan plus a reviewer-agent accept on the current head (§3a). Every red line other than those
protected-path bootstrap lines must pass.
