---
change_class: standard
---
# plan(owner-autonomy): one standing autonomy rule for every Vitana session and process, with one complete stop list
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202610261510-099d` (Kiro Web). Repos: `exafyltd/vitana-platform`
(spec) and `exafyltd/vitana-v1`. Premises pinned to platform `origin/main` `fd243f5a86`, vitana-v1 `origin/main`
`fb9b6d843`. Detail per lane: `tasks.md`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-27 (Kiro Web): *"I want you to fix this for all future Kiro Web sessions and all Vitana processes, not
only the current pipeline task. … when I ask you to do something, carry it through to the authorized outcome without
repeatedly coming back to me for approval of routine steps. This applies to investigation, planning, implementation,
testing, fixes, reviews, PRs, permitted merges, reruns, documentation, closing records, and cleanup. For development
tasks, the default outcome is STAGING VERIFY, unless I specify a different endpoint."* Also: *"Keep genuine stop
conditions clear and specific … Do not silently remove security, production, data-loss, or migration safeguards."*
And: *"do not end a response with 'I can continue,' 'shall I proceed?' or a similar question when the next step is
routine."* No safeguard is removed or loosened. CLAUDE.md (a protected gate file) is not changed.

## 2. Today (file:line at the pinned refs)
1. The pipeline steering covers only commits. Platform `.kiro/steering/vitana-pipeline.md:3`: "Every owner task that
   results in a commit runs the Vitana pipeline"; `:10-12` is the only owner-stop list a Kiro session loads
   ("Gate 2 and an escalated sparring verdict, plus the stop cases of `collaboration.md` §7"). Investigations,
   questions, read-only reviews, ops checks and cleanup have no "do not ask" rule. The nearest one, CLAUDE.md IF–THEN
   10, is phrased for an approved plan.
2. That list leaves out the migration safeguard. `collaboration.md:205` and §7d `:297-305`: a migration needs the
   owner's approval of the file(s) and the target database, and "a policy approval (`converged-auto-v1`) never
   authorises a migration". The protected-gate-file merge rule (§3a `:132`, §7b `:253`) is missing too. Both can stop
   work before STAGING-VERIFY, and a session cannot see that from the list it loads.
3. Several sentences are broad enough to be read as "ask about anything":
   - vitana-v1 `CLAUDE.md:30-31`: "When in any doubt, **stop and ask first.** Writing to a shared/live system … requires
     explicit approval". This is the paragraph on writes to live systems.
   - platform `CLAUDE.md:200` NEVER 34: "Never enable autonomy without explicit approval". This is under "AI & Autonomy"
     (product AI rules).
   - `docs/DEPLOYMENT-PIPELINE.md:23`: "PR reviewed + approved". This conflicts with reviewer-agent acceptance
     (`collaboration.md` §7).
   Other stops sit in files a session reads only by path: vitana-v1 `CLAUDE.md:355` (Commerce onboarding friction
   needs owner approval before merge) and vitana-v1 `.claude/rules/design.md:24` (design contract change).
4. vitana-v1 is behind platform on the review rule. v1 `.claude/rules/collaboration.md:192-193`: "The model
   unavailable → the agent fails loudly …, the lane stays `in-review`, no other model is substituted". That makes a
   session wait. Platform §7 `:193-197`: the three-model chain, "never wait on an unavailable model". v1
   `.kiro/steering/vitana-pipeline.md:4` names one model. The two `collaboration.md` files say they are identical
   (`collaboration.md:10`).
5. vitana-v1 `CLAUDE.md` has no "Policy approval replaces Gate 1" paragraph (platform `CLAUDE.md:34`). Kiro sessions
   also load platform CLAUDE.md, where the paragraph exists. v1 `CLAUDE.md` is a protected gate file, so it is left
   unchanged; the new rule file says which text governs.
6. Kiro Web loads the repos' steering through `scripts/collab/kiro-web-steering.mjs`, which copies every
   `.kiro/steering/*.md` (VTID-05339). A new always-included steering file reaches every Kiro Web session without
   further wiring. User-level learnings and Configuration Sync cover the case where the repos' steering is not loaded yet.
7. `scripts/ci/kiro-steering/guard.cjs` (both repos) runs in PR-GATE: platform `PR-GATE.yml:66`, v1 `PR-GATE.yml:77-78`.
   Today nothing checks that a stop rule stays listed. The agent checks are scoped by file existence
   (platform `guard.cjs:88`).
8. Open plan #4392 (`kiro-web-reliability`) changes `AGENTS.md`, `.kiro/pipeline/driver.md` and
   `scripts/collab/kiro-web-session.mjs`. This plan touches none of those files.

## 3. Change
**A. New `.kiro/steering/vitana-owner-autonomy.md`** (`inclusion: always`). Byte-identical in both repos. Contents:
- the owner's instruction, quoted;
- scope: every session type (Kiro Web, Kiro IDE, automations, sub-agents, Claude Code) and every kind of work;
- the outcome to run to: STAGING-VERIFY passed on the merge commit for a commit (merged-green + closing records
  when nothing deploys; Gate 2 is the report at the end, not a "continue?" question); the finished answer with
  evidence, read-only, for any other task; an end point the owner names instead of the default;
- the routine steps that are never asked about, and "never end a reply with an offer or a question about a routine
  next step";
- **the complete stop table**, each row with its existing rule and whether it can stop work before STAGING-VERIFY:
  migration apply §7d; production §7c/§7d/IF–THEN 22–26; protected gate files §3a/§7b; security or data loss; 3
  failed fix-forwards; escalated sparring or out-of-plan work; verification that needs a live write (v1 absolute
  rule, IF–THEN 31–32); another repository (`AGENTS.md`); Commerce friction (v1); design-contract change (v1); VTID
  allocator down (§4.1); Gate 1 for Claude-local sparring only;
- how to read the §2.3 sentences. Each keeps its own scope (live writes; product autonomy; reviewer-agent accept), and
  IF–THEN 9 keeps every stop;
- the stop message: the five-part message of §7, which names the exact rule and the decision needed, sent after all
  unblocked work is finished.
**B. `.kiro/steering/vitana-pipeline.md`** (platform; v1 gets the identical file). The owner-stop sentence is
replaced by a pointer to the complete table in A, naming migration approval (§7d) and protected gate files (§3a)
explicitly. A line says that work that does not result in a commit follows A too. The v1 copy also gets the
model-chain text it lacks (§2.4).
**C. vitana-v1 `.claude/rules/collaboration.md`**: replaced with the platform file byte for byte (§2.4: reviewer
model chain, "never wait"). This changes no stop rule.
**D. `scripts/ci/kiro-steering/guard.cjs` + `guard.test.cjs` (both repos)**: a new check `checkOwnerAutonomy(root)`,
called from `check()` when `.kiro/steering/vitana-pipeline.md` exists. It fails when
`.kiro/steering/vitana-owner-autonomy.md` is missing, is not `inclusion: always`, or no longer names each stop
anchor: `§7d`, `§7c`, `§3a`, `AGENTS.md`, `five-part`, `STAGING-VERIFY`, the "never end a reply" rule. It also fails
when `vitana-pipeline.md` does not name `vitana-owner-autonomy.md`. So a later edit that drops a safeguard from the
list, or drops the rule file, is a red check rather than a quiet change.
**E. Platform `docs/kiro/kiro-web-bootstrap.md` and `docs/kiro/cloud-config/vitana-kiro-web-bootstrap.md`**: the
Configuration Sync file carries a short form of the standing instruction and stop list, so it applies before the repos'
steering is loaded. It also says to run `kiro-web-session.mjs setup` when that exists, else `kiro-web-steering.mjs`.
The doc adds the audit table (§2) and what was verified.

Lanes (parallel, no shared file; one VTID each):
- **`platform-rules`** (vitana-platform): `.kiro/steering/vitana-owner-autonomy.md`, `.kiro/steering/vitana-pipeline.md`,
  `scripts/ci/kiro-steering/guard.cjs`, `scripts/ci/kiro-steering/guard.test.cjs`, `docs/kiro/**`,
  `docs/validation/VTID-*/**`.
- **`v1-rules`** (vitana-v1): `.kiro/steering/vitana-owner-autonomy.md`, `.kiro/steering/vitana-pipeline.md`,
  `.claude/rules/collaboration.md`, `scripts/ci/kiro-steering/guard.cjs`, `scripts/ci/kiro-steering/guard.test.cjs`,
  `docs/validation/VTID-*/**`.
Both lanes: `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer`. `.kiro/steering/**` and `.claude/**` are
governance paths (`queue.mjs:85`); `queue.mjs:231-234` allows an `executor: kiro` lane to change them with the reviewer
agent. No path is in `scripts/collab/protected-gate-files.json`. Interface: A is byte-identical in both lanes, and so
is B; each lane's evidence records the sha256.

## 4. Tests (written first, red on base)
`guard.test.cjs` in each repo:
1. A repo with `vitana-pipeline.md` and no rule file fails ("vitana-owner-autonomy.md missing").
2. Each removed anchor (`§7d`, `§7c`, `§3a`, `AGENTS.md`, `five-part`, `STAGING-VERIFY`, never-end-a-reply) fails and
   is named.
3. `inclusion: manual` fails.
4. `vitana-pipeline.md` without the pointer fails.
5. Fixture repos without `vitana-pipeline.md` stay green (existing tests unchanged).
6. "This repository passes" (existing test) covers the shipped files.
Run: `node --test scripts/ci/kiro-steering/guard.test.cjs` and `node scripts/ci/kiro-steering/guard.cjs .` in each
repo (PR-GATE). Platform: also `node --test scripts/collab/*.test.mjs` (the generator mirrors the new file). Then
`kiro-web-steering.mjs --check` on the two-repo workspace.

## 5. Verification after merge (driver)
- Fresh sandbox: clone both repos from `origin/main` into an empty directory, run the generator, then `--check` → ok.
  The new file is in the generated set.
- New session: a fresh sub-agent session (it gets the workspace steering) states the rule, the default end point and
  the stop table without reading any file. Then it runs two tasks without asking: a read-only investigation (not the
  pipeline) and a routine step chain. Its replies are checked for approval questions or trailing offers.
- Learnings: the account learning is replaced by the general instruction (owner's words plus the stop pointer).

## 6. Unchanged
Every rule file except the two steering files and the v1 `collaboration.md` sync. Every stop condition. Protected
gate files (`CLAUDE.md` in both repos). Migration, production, live-write, security and data-loss rules. `AGENTS.md`
and `driver.md` (owned by plan #4392). Deploys nothing.

## 7. Risks
- The always set grows by about 5 KB. Accepted; it is the rule file every session needs.
- The guard anchors are text checks, so they keep the list from shrinking. They do not prove a session follows it,
  which is why the §5 behaviour test exists.
- Text that reads a broad sentence narrowly could be seen as loosening it. Mitigation: each reading quotes the
  sentence, keeps it in force for its own topic (live writes, product autonomy), and adds a stop row for it.
<!-- plan:end -->
