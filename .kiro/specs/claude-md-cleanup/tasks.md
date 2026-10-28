# Tasks — claude-md-cleanup
Authoritative plan: `plan.md` (this folder). Lane files: `lanes/`.
VTID: allocated by PLAN-SPAR after approval (one per lane). Kiro never allocates one.

<!-- lane: rules-trim -->
## rules-trim — platform CLAUDE.md + Kiro steering (repo vitana-platform)
Allowed paths:
- `CLAUDE.md`
- `.kiro/steering/vitana-kiro-notes.md`
- `.kiro/steering/vitana-load-project-rules.md`
- `docs/validation/<VTID>/**` (the lane's own evidence)

- [ ] P0. Claim commit on the lane branch: lane log entry "Owner exception: executor: claude, built by Kiro (owner
  instruction 2026-10-20)"; informational `reviewer:` line → owner / legacy Claude (§3a), reviewer agent advisory.
- [ ] P1. Before: `(Get-Content CLAUDE.md).Count` and the MUST-KEEP token grep (plan "Verification") into
  `commands.log` / `outputs/must-keep-before.txt`.
- [ ] P2. Plan items A, B (delete IF–THEN 20), C, D, E (rule 26 kept in full substance), F, G, H, I, K, M in
  `CLAUDE.md`, outside any generated marker.
- [ ] P3. Numbering per plan "Numbering (J)": plain digits kept, `AI-27`–`AI-31` with the "IF–THEN 27–31" alias line,
  retired-number index at the end of Part 1; `git grep` both repos for references to changed or retired labels; fix
  those inside lane paths; `outputs/xref-sweep.md` lists every other hit with what it resolves to (none in
  `.claude/rules/**` / `.kiro/steering/**` may resolve to nothing).
- [ ] P4. Steering: remove the "about 1,000 lines" claim and duplicated session-start text; roles keep pointing at
  `collaboration.md` §7–§7b; keep "never test against production" and the session-start steps once.
- [ ] P5. After: token grep (`outputs/must-keep-after.txt`, every token present), duplicate-label grep (none), line
  counts, a removed/condensed/kept table per file (`outputs/diff-review.md`): per-removal table per plan "Removal table" (every retired number, flag rows on top) plus a "weakened on purpose" row for K.
- [ ] P6. Evidence pack `docs/validation/<VTID>/` (`acceptance.md` with `AC-n` + `TEST:` lines, `commands.log`,
  `outputs/`); `node scripts/collab/queue.mjs validate --base origin/main --head HEAD`.
- [ ] P7. PR `VTID-xxxxx (claude-md-cleanup/rules-trim): …`; first body section "Owner exception: executor: claude,
  built by Kiro" (plan Decision 2), then the Removal table for per-row owner confirmation (Decision 11), then the platform PR-GATE body fields, the external references list and the
  deferred list. Reviewer agent review (advisory); accepting review = owner / legacy Claude (§3a). Do not merge.

Acceptance:
- Every MUST-KEEP token present after the change; no Part 1 label used twice; platform `CLAUDE.md` ~400–550 lines.
- `node scripts/collab/queue.mjs validate --base origin/main --head HEAD` passes.
- The diff touches only the allowed paths; `.claude/CLAUDE.md` unchanged.
<!-- lane: rules-trim -->

<!-- lane: rules-trim-v1 -->
## rules-trim-v1 — v1 CLAUDE.md + Kiro steering (repo vitana-v1)
Allowed paths (in `exafyltd/vitana-v1`):
- `CLAUDE.md`
- `.kiro/steering/vitana-kiro-notes.md`
- `.kiro/steering/vitana-load-project-rules.md`
- `docs/validation/<VTID>/**` (the lane's own evidence)

- [ ] V0. Claim commit on the lane branch: lane log entry "Owner exception: executor: claude, built by Kiro (owner
  instruction 2026-10-20)"; informational `reviewer:` line → owner / legacy Claude (§3a), reviewer agent advisory.
- [ ] V1. Before: line count and token grep (the plan's tokens present in v1 today, plus `20260805160000`).
- [ ] V2. Plan item K (`:486-574`) as in the platform lane; "Why no host is exempt" (`:263-311`) to rule + one "why"
  clause, keeping the `20260805160000` guards and `notification_test_actors` registration; M (`:96-106`).
- [ ] V3. Steering files byte-identical to the platform lane's result.
- [ ] V4. After: token grep, line counts, removed/condensed/kept table; evidence pack; v1 PR gate requirements read
  from its `.github/workflows` and met.
- [ ] V5. PR `VTID-xxxxx (claude-md-cleanup/rules-trim-v1): …` with the same "Owner exception" first section. Reviewer
  agent review (advisory); accepting review = owner / legacy Claude (§3a). Do not merge.

Acceptance:
- Every token present before is present after; v1 `CLAUDE.md` ~450–480 lines; every section the plan lists as kept is
  still there.
- The diff touches only the allowed paths; `.claude/CLAUDE.md` unchanged.
<!-- lane: rules-trim-v1 -->
