---
change_class: standard
---
# plan(e2e-autonomy): the owner's end-to-end autonomy rule joins the standing steering

Author: Kiro, seat `exafy`, session `kiro-exafy-202611021438-cff7` (Kiro Web). Premises: vitana-platform `origin/main`
`4066f563e7232237f77c44469c77924b94d1e098` (the base commit of this PR) and vitana-v1 `origin/main`
`7829ef2f2ef12364862961d339161229c286d6f0` (companion ref in `handoff.md`).

<!-- plan:begin -->
## 1. Goal
Owner, 2026-11-04, in the Kiro Web session, as a steering rule "I would like to build": *"Kiro owns approved engineering
work end-to-end. … The normal stopping point is: STAGING-VERIFY complete, closing records updated, and the owner told
exactly what is ready to verify on staging."* and *"Every fresh Kiro account/session must behave as if it inherited the same
engineering operating model. … The new session must not require the owner to restate this autonomy model."*

The standing owner instruction already exists as `.kiro/steering/vitana-owner-autonomy.md` (plan `owner-autonomy`,
VTID-05344): always included, one complete stop table, checked by `scripts/ci/kiro-steering/guard.cjs`, loaded into every Kiro
Web session by `kiro-web-steering.mjs`. The owner's new text says the same thing in more detail. This plan merges it into that
file instead of adding a second file, so there is still one place and one stop table.

Done when: both repositories carry the same file with the owner's sections added; the guard fails CI if a section or a stop is
dropped; a fresh Kiro Web session loads it through the existing generator without any owner step.

## 2. What the owner's text adds, and what it repeats
| Owner's section | Against what exists today |
|---|---|
| Primary operating principle; Definition of done | Same end point as today (STAGING-VERIFY, then Gate 2); stated as the normal stopping point and with the list of places not to stop at |
| Default execution sequence (26 steps) | New as one list; each step is already a rule of `driver.md`, `common-rules.md` or `collaboration.md` |
| Approval model (the eight questions never asked) | Same as "Never ask about routine steps"; now with the questions named |
| When Kiro may interrupt the owner (A to E) | New framing of the kinds of stop. The 13-row stop table stays the complete list |
| Reviewer autonomy | Agrees with `driver.md` step 4; adds: a temporarily unavailable reviewer never stops the whole task |
| CI autonomy | Adds: inspect queue causes and cancel verified superseded PR runs where allowed (plan `ci-superseded-pr-runs`); the re-run allowlist of `collaboration.md` §7a is unchanged |
| Staging autonomy; Production boundary | Agrees with §7c/§7d; staging migrations only where already authorized (see below) |
| Fresh-session behavior | Agrees with `vitana-load-project-rules.md` and the generator; adds nothing to do |
| Communication style | New: good and bad examples; progress updates are information, not approval prompts |

## 3. What Kiro adds, for the owner to confirm at the sparring record
One subsection, "Precedence and scope", marked as Kiro's:
1. The stop table stays the complete list. A to E are the kinds of stop; every row is one of them; where the model and the
   table differ, the stricter rule applies (CLAUDE.md IF–THEN 9). Nothing removes a stop.
2. "Run required migrations where already authorized by the approved plan" is read as: the plan names the file(s) and the
   target database and the owner approved them. Otherwise stop 1 applies, because staging shares the production database. A
   plan approved by CI policy (`converged-auto-v1`) alone does not authorize a migration.
3. Where the text says GitHub, read the Git host in use (GitHub today, GitLab after a cutover).

## 4. Lane
One lane, `steering` (vitana-platform and vitana-v1, executor kiro, seat exafy, reviewer agent). It opens one PR per repository
with the same VTID. The exact new file is `rule-text.md` in this spec; the lane copies it unchanged into
`.kiro/steering/vitana-owner-autonomy.md` in both repositories (byte-identical). Before the change the two copies differ in
exactly one line, stop row 3, and that difference is a change of meaning, not of wording:
- vitana-v1 today: a protected gate file needs *"a Claude review on the current head or an owner instruction that names the
  plan"* (review OR instruction; `exafyltd/vitana-v1:.kiro/steering/vitana-owner-autonomy.md:42`).
- The platform: *"the owner's instruction naming the plan plus a reviewer-agent accept on the current head (Claude Code is
  retired)"* (instruction AND reviewer-agent accept; `.kiro/steering/vitana-owner-autonomy.md:42`).
Copying the platform file therefore **tightens** row 3 in vitana-v1, on purpose. The platform's reading is the binding one:
`.claude/rules/collaboration.md` §3a (`:138-140`) and §7b (`:270-271`) on the platform's `origin/main`, set by VTID-05409 (commit
`2482d52460`, 2026-10-29, "Claude-free protected-gate authority"), and vitana-v1's own `CLAUDE.md:107-108` already says it.
vitana-v1's steering copy (taken from vitana-v1's `.claude/rules/collaboration.md:132,253`) is the stale one. That
`collaboration.md` copy lags the platform's by 27 differing lines; syncing it is a separate change and not part of this plan
(§7, §8). The lane says so in the body of the vitana-v1 PR. The lane also:
- adds one text anchor per new section and one for the precedence sentence to `OWNER_AUTONOMY_TEXT_ANCHORS` in
  `scripts/ci/kiro-steering/guard.cjs`, and the matching tests in `guard.test.cjs` (both repositories, same change);
- adds a short paragraph to `docs/kiro/kiro-web-bootstrap.md` (platform) under "Autonomy: one rule for every task".

Unchanged: the 13 stop rows and their anchors (the words of row 3 in vitana-v1 change as described above, its anchor does not);
`vitana-pipeline.md`; `AGENTS.md` (it already points to the file); `CLAUDE.md` (protected gate file); the Kiro Web
cloud-config bootstrap file (so the owner has nothing to re-upload).

## 5. Tests (red on base)
In `scripts/ci/kiro-steering/guard.test.cjs`: the shipped file passes; dropping any of the eleven new anchors fails with
"no longer names …"; the anchor count test goes from 16 to 27; the existing 16 tests stay unchanged. On base the new anchors
are missing from the file, so the new tests fail. Evidence: the two `sha256sum` lines showing the file is byte-identical in
both repositories, and `kiro-web-steering.mjs --check` with the generated size before and after.

## 6. Staging verification and acceptance
Deploys nothing. Not verified on staging: steering text and a CI guard only. Done when both PRs are merged with green required
checks and the closing records are merged. A fresh Kiro Web session then loads the new sections through the generator; the
lane records `kiro-web-steering: ok` and the byte size.

## 7. Risks
- The always-included file grows from about 7.5 KB to about 15.7 KB. The generator already reports the size; the lane records it.
  If a session truncates it, the sections the guard names are the ones to keep.
- Two lists of stops could drift: the table is the only complete list and the precedence sentence says so, guarded by an anchor.
- The migration reading in §3 narrows the owner's sentence on purpose. The owner can widen it by editing that bullet.
- After the change, row 3 of vitana-v1's steering file (instruction AND reviewer-agent accept) disagrees with vitana-v1's own
  `.claude/rules/collaboration.md:132,253` (review OR instruction) until that copy is synced. The steering row follows the
  binding text of the platform's `origin/main`; vitana-v1 `CLAUDE.md:107-108` agrees with it. The effect is only stricter: a
  protected gate file never merges on less than the platform rule requires.

## 8. Unchanged, and what this plan does not do
Every owner stop, Gate 1 and Gate 2, production, the pipeline files, `CLAUDE.md`, and the cloud-config file. Also unchanged:
vitana-v1's `.claude/rules/collaboration.md`, which lags the platform's copy by 27 lines (§4 and §7). Bringing it level is a
separate change on a governance path; this plan records the lag and does not widen to it.
<!-- plan:end -->
