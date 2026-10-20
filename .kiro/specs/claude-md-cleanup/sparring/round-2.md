# Sparring round 2 — in_progress

Session: `869ca9e4-b9c6-4d28-8a9e-3580a9ec58ad` · plan hash `d93a6bf633102d26b622b36fe2bb0bccff74195ae5c9817f6902d4b690b5f3a8`

## Summary

The revision genuinely addresses all four round-1 findings: Numbering (J) now keeps plain digits with an AI-27..AI-31 alias and a retired-number index plus a hard-failing sweep; Decision 2 reframes executor:claude as a named owner exception rather than a self-unlock; K is explicitly flagged as an intentional owner-instructed downgrade (Decision 10); and Decision 3 + the rewritten M paragraph align the review path with the lane front matter. I verified the key premises against the pinned code (the AI 26/ALWAYS 10a duplicate, the "IF-THEN 31" Bedrock-ordering references in backend.md, the already-rewritten steering files, the ALWAYS 21-22 and 31-34 collisions, and the Collaboration paragraph). Two new findings remain: (1) a loose owner chat instruction ("make changes you recommend") is being used to authorize sweeping deletion of safety/governance-adjacent rules without a specific owner confirmation of the deletion list before build, with the owner only seeing the diff at protected-gate PR review — a governance gap for a 600-line deletion; (2) the diff-review asserts a priori that K is the only "weakened on purpose" change, which conceals specific substantive removals (NEVER 40 "never bypass validation", ALWAYS 18 provider/model/latency logging) that support other must-keep rules (silent-fallback detection), and so won't get a dedicated owner confirmation.

## Findings

### R2-N1 [major]

The sole recorded authority for deleting ~600 lines (1021→400-550) is a loose owner chat instruction — "ok, update claude.md and make changes you recommend here" (Decision 2) — with the owner's only gate being the protected-gate PR review at the end (§3a/§7b, after the lanes are fully built). For a Kiro plan, Gate 1 is replaced by CI policy converged-auto-v1, not the owner (Autonomy contract lines 66-72), so the owner never sees or approves a specific list of which rules are being deleted before the build happens. A "make changes you recommend" instruction is being treated as authorization to delete safety/governance-adjacent rules (NEVER 40 "never bypass validation", the mandatory→recommended codebase-intelligence downgrade, incident 'why' clauses, provider/model/latency logging) as if the owner had reviewed and approved each removal. The plan's own MUST-KEEP audit and the protected-gate review happen only at PR time, when the work is done, not as a scoped pre-approval.

- `exafyltd/vitana-platform:CLAUDE.md:66` — Policy approval replaces Gate 1 for CI-sparred plans ... A plan sparred by PLAN-SPAR.yml whose session converged is approved by the policy converged-auto-v1 ... it is not sent to the owner.
- `exafyltd/vitana-platform:CLAUDE.md:121` — Kiro plans, builds and reviews (one Kiro account reviews another's lane); CI spars every plan ... the Project Manager merges by rule ...
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:247` — no protected gate file (§3a) is changed without a legacy claude review on the current head or the owner's instruction.
- `exafyltd/vitana-platform:CLAUDE.md:303` — 37. **Never respond confidently when uncertain.** ... 40. **Never bypass validation.**

Suggestion: Before the lanes are built, surface an explicit deletion list (rule number → disposition: removed/condensed/retired, with the substance's new home) to the owner as a single confirmation, distinct from the 'make changes you recommend' chat instruction — or treat the owner's PR-body confirmation (Decision 2c) as the explicit approval of each listed removal, named per-rule, not blanket. The owner should confirm a rule like NEVER 40 ('never bypass validation') and ALWAYS 18 (logging) is genuinely droppable, not just that the mechanism is sound.

### R2-N2 [minor]

The Verification section asserts the diff-review 'weakened on purpose' row is K only (R1-F3), which pre-declares the outcome and omits other substantive removals that are NOT generic 'be careful' lines. Specifically: NEVER 40 ('Never bypass validation', line 305) is deleted under the A 'generic rules' umbrella but is a specific validation-bypass prohibition, and ALWAYS 18 ('Always log provider, model, and latency for AI calls', line 210) is deleted although the 'no silent fallback' must-keep rules depend on observability (rule 53 requires fallback tiers be 'logged loudly' and recorded in model_log.fallback_tier). Deleting ALWAYS 18 weakens the evidence base for detecting the exact silent-fallback incident the must-keep list preserves. Neither gets a dedicated 'weakened/condensed' row for owner confirmation, because the plan fixes 'K only' up front.

- `exafyltd/vitana-platform:CLAUDE.md:303` — 37. **Never respond confidently when uncertain.** ... 40. **Never bypass validation.**
- `exafyltd/vitana-platform:CLAUDE.md:210` — 18. **Always log provider, model, and latency for AI calls.** 19. **Always treat CI/CD as governed, not ad-hoc.**
- `exafyltd/vitana-platform:CLAUDE.md:493` — The chain lives in the partner pass ... is sticky per round, logged loudly and recorded per entry in model_log.fallback_tier.

Suggestion: Generalise the diff-review 'weakened on purpose' audit to a per-removal table (every deleted number: substance, why safe to drop, where the substance now lives), rather than declaring 'K only'. Flag NEVER 40 and ALWAYS 18 explicitly so the independent reviewer and owner confirm they are deliberate, not accidental collateral of the generic-rule sweep.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and addressed: Numbering (J) keeps plain digits (option a), adds the AI-27..AI-31 alias for the one surviving Bedrock/test-account collision, a retired-number index, and a hard-failing sweep over .claude/rules/** and .kiro/steering/**. I verified the 'IF-THEN 31' Bedrock references in backend.md resolve to AI-31 via the alias.
- R1-F2: acknowledged — Accepted and addressed: Decision 2 now frames executor:claude as a named owner exception recorded in the lane log/PR body, and explicitly states the field unlocks no merge (owner/legacy-Caude review still required).
- R1-F3: acknowledged — Accepted and addressed: K is now Decision 10 and a dedicated 'weakened on purpose' row. (See R2-N2 for a residual audit-completeness concern about other substantive removals.)
- R1-F4: acknowledged — Accepted and addressed: Decision 3 states the review path is owner/legacy-Claude for executor:claude protected-gate lanes, reviewer agent posts advisory input only, and the M paragraph now agrees.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
