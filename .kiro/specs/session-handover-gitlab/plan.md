---
change_class: standard
---
# plan(session-handover-gitlab): a standing CLAUDE.md rule that every session handover is pushed to GitLab
Author: Kiro, seat `exafy`, session `kiro-exafy-202611110004-e38b` (Kiro Web). Repos `exafyltd/vitana-platform`, `exafyltd/vitana-v1`.
<!-- plan:begin -->
Pins: vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`, vitana-v1 `e31bf4627ff3c705c20f8e6b718ce4dd03353b7f`.
## 1. Goal
Owner, 2026-11-11, in the Kiro Web session: *"write this into claude.md so future handover go straight to gitlab"*.
This is the owner's instruction naming this plan for the protected gate file `CLAUDE.md` (`collaboration.md` §3a).
## 2. Today
- Kiro Web sessions in the same account do not share a sandbox. On 2026-11-11 a handover file and two bundles existed
  only under `/projects/sandbox/`; the next session started fresh and could not read them. The strategy commits
  survived only because the old sandbox was still alive and pushed them (GitLab `vitana/vitanaland-strategy` branch
  `kiro/phase-three-strategy` now at `309ba6e293fdf5dc967d33e5e83fd643d04deaad`, handover at
  `19-EXECUTION-PROGRAMME/SESSION-HANDOVER.md`).
- `CLAUDE.md:71-85` and vitana-v1 `CLAUDE.md:96-110` say "push and update the lane file before ending" but name no
  handover location and no check that the push landed. No rule says the sandbox is not shared.
## 3. Change
The same new section, inserted right after the "CLAUDE CODE ↔ KIRO COLLABORATION" section in both repos' `CLAUDE.md`
(platform after line 85, v1 after line 110), text exactly:

## 📦 SESSION HANDOVER: STRAIGHT TO GITLAB (STANDING RULE, owner decision 2026-11-11)
A session's sandbox is temporary: the next session, even in the same account, starts in a fresh sandbox and cannot read
the old one's files, worktrees, bundles or chat. On 2026-11-11 two strategy commits and a handover lived only in a
sandbox and were nearly lost. So **a handover exists only once it is pushed to GitLab**:
1. **Push the work first.** Every commit the next session needs is pushed to its branch on the GitLab project of its
   repo (`vitana/vitanaland-strategy`, `vitana/vitana-platform`, `vitana/vitana-v1`), never only committed locally,
   bundled or kept in a worktree. While the GitHub to GitLab cutover is open, a platform/v1 branch is also pushed where
   its PR or MR lives.
2. **Write the handover as a file in GitLab:** `19-EXECUTION-PROGRAMME/SESSION-HANDOVER.md` on the working branch of
   `vitana/vitanaland-strategy` (one place every session can fetch). It holds: what the owner asked for, branches and
   exact SHAs, PR/MR links, plan slugs and VTIDs, lane states, blockers with the owner decision each needs, and the next
   steps in order. Paths under the sandbox (`/projects/sandbox/...`, worktrees, `.agents/`) are never the only copy of
   anything it names. A plan's own state stays in `.kiro/specs/<slug>/handoff.md` and lane files as before.
3. **Verify before ending:** `git ls-remote origin <branch>` shows the pushed SHA for every branch named in the
   handover. If a push fails (for example a 403 from the Kiro gateway), the session tells the owner at once and does not
   report the handover as done.
4. **A new session starts there:** `git fetch` the strategy branch and read `SESSION-HANDOVER.md` before any other work.

Each repo gets a test that fails on base and passes when the section is present: vitana-platform
`scripts/collab/session-handover-rule.test.mjs` (node:test), vitana-v1 `src/lib/claude-md-session-handover.test.ts`
(Vitest). Each asserts the heading, the GitLab file path `19-EXECUTION-PROGRAMME/SESSION-HANDOVER.md`, the
`git ls-remote` verification step and the sandbox sentence.
## 4. Lanes
1. `claude-md-platform` (vitana-platform): `CLAUDE.md`, the test, `docs/validation/VTID-*/**`.
2. `claude-md-v1` (vitana-v1): `CLAUDE.md`, the test, `docs/validation/VTID-*/**`.
`CLAUDE.md` is a protected gate file, so both lanes are `executor: claude`; while Claude is unavailable the exceptions mode of `collaboration.md` §7 applies (a Kiro session builds, a Kiro session of the reviewer seat `exafyltd` reviews, the owner instruction in §1 is the merge authority). Independent, may run in parallel. `CLAUDE.md` is a hot file: only these lanes touch it while open.
## 5. Tests and commands
platform: `node --test scripts/collab/session-handover-rule.test.mjs`, `node --test scripts/collab/*.test.mjs`, Kiro steering
guard, preflight. v1: `npx vitest run src/lib/claude-md-session-handover.test.ts`, `npm test`. Red on base recorded.
Kiro Web picks the rule up automatically: `.kiro/steering/vitana-standing-rules.md` links `CLAUDE.md` with
`#[[file:CLAUDE.md]]`, and `scripts/collab/kiro-web-steering.mjs` mirrors that steering file (with a prefixed link) into
the workspace at session start.
Verified for v1 at the pin: the collaboration section is `CLAUDE.md:96-110` (next heading `## Overview` at `:112`);
`vitest.config.ts` includes `src/**/*.{test,spec}.{ts,tsx}`; `package.json:30` `npm test` ends with `vitest run`. The
builder re-checks these three facts on its base and records them in the lane log; if the structure differs it inserts
after the collaboration section wherever it is.
## 6. Merge
Protected gate file: merges only with this owner instruction plus a reviewer-agent accept on the current head (§3a, §7b).
Deploys nothing; done when merged green.
## 7. Unchanged
Every other rule, file and behaviour.
<!-- plan:end -->
