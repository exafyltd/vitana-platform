# Sparring round 3 — escalated

Session: `591783a3-f420-43e1-aae2-c6cc444d1664` · plan hash `d82793b5673f385b122690dbf9988acec58b9f645173256ce449d7b95e9dbee4`

## Summary

The revision properly resolved R1-F1 (explicit owner Gate 1 "yes" for §7d activation, a governance change that correctly overrides converged-auto-v1), and the accepted fixes R2-F1 (B.6 owner-only approval source), R2-F2 (non_transactional recording + §D.3), and R2-F3 (B.4 step 5 mechanical enumeration). Premise checks confirm the frozen-vs-live production workflow landscape the plan's B.4 staging-only check relies on (AUTO-DEPLOY, vitana-v1 DEPLOY, supabase-functions-deploy all frozen by time-based cutover_gate; DEPLOY-CLOUDFLARE-WORKERS unfrozen). Two concerns remain: (1) a textual-contradiction risk where §7a's flat "never ... dispatch a workflow / deploy — except under §7b" is only given a pointer sentence to §7d rather than having its prohibition amended, leaving a session facing two conflicting rules; (2) the automation files' closing line "(or, until it runs, Claude Code) merges verified lanes" is required absent by the grep test but not explicitly named in the Files edit list.

## Findings

### R3-F1 [major]

The plan keeps §7a's text byte-for-byte and 'only gains one pointer sentence to §7d' (§7a: 'merge or approve a PR on GitHub (the Project Manager merges), dispatch a workflow, or deploy — except under the owner-directed exception in §7b below'). But §7d/B.5 explicitly grants Kiro authority to 'dispatch or re-run staging and verification workflows' and B.6 grants dispatch of RUN-MIGRATION.yml. The §7a exception clause names only §7b, not §7d, so a session (and any future reviewer or automation) loading §7a reads a flat 'never dispatch a workflow or deploy' prohibition whose sole named exception is §7b (staging-only owner-instructed merge). The result is two directly conflicting rule sentences active at once in the same file — exactly the ambiguity class R1-F1 flagged — rather than an amendment that resolves the contradiction.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:162` — merge or approve a PR on GitHub (the Project Manager merges), dispatch a workflow, or deploy — **except under the owner-directed exception in §7b below**

Suggestion: Amend §7a's prohibition sentence itself (not merely append a pointer) to name §7d as an additional exception source — e.g. '— except under §7b or §7d below' — so no reader encounters a flat 'never dispatch/deploy' that is contradicted later. The structure-check test should assert §7a's exception clause references both §7b and §7d.

### R3-F2 [minor]

The Test 'scoped grep' requires that the pattern '(or, until it runs, Claude Code) merges' not remain in the changed automation files, but the Files section (item 4) enumerates specific edits ('step 1 never list', 'step 6 stops', 'Reviewer B no longer leaves verified', 'new item D') without explicitly listing removal/rewrite of the closing line 'The Project Manager (or, until it runs, Claude Code) merges verified lanes, watches staging and sends the owner Gate 2' that appears verbatim in all three automation files. If the implementer follows only the enumerated edits and misses the closing line, the acceptance grep fails — the test and the edit list are out of sync, and the line is a live 'hand the merge to Claude Code' instruction that §A says must disappear.

- `exafyltd/vitana-platform:.kiro/automations/exafy.md:81` — The Project Manager (or, until it runs, Claude Code) merges verified lanes, watches staging and sends the owner Gate 2.

Suggestion: Add the closing-line rewrite to the Files item 4 edit list explicitly (e.g. 'remove/replace the closing 'The Project Manager (or, until it runs, Claude Code) merges...' line'), so the enumerated edits and the acceptance grep are consistent.

## Acknowledgements of earlier responses

- R2-F3: acknowledged — The deformation of mechanical enforcement to a follow-up plan (merge-deploy-guard) is acceptable: the revision keeps automation runs at 'stop at verified' until that plan lands, and restricts the B.4 staging-only check to interactive sessions using a git show enumeration. The remaining residual (session must still read each cutover_gate's logic on main to confirm the freeze) is bounded by interactive-only and is a known, stated limitation, not a hidden gap.
