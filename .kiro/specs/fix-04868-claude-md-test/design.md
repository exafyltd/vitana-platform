# Design — fix-04868-claude-md-test
## What exists (read these, do not copy them)
- `services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts`
  - `:28-43` case `CLAUDE.md carries rules 51-55 and puts allocation after sparring`; `:42` the failing assertion.
  - `:30-40` the other CLAUDE.md assertions (all pass on `origin/main`); `:36` already pins rule 51's
    `Plan → sparring → owner approval … → VTID → code.` flow.
- `CLAUDE.md` on `origin/main` @ `c7819403926c8082084cc60223be57897b7f806a` (protected, read only):
  - `:496` `### 4.1 Allocation (STANDING RULE — VTID-03448, VTID-04868)`
  - `:498` `**It is allocated only after its plan is sparred and approved** (Part 1 rules 51–55): owner`
  - `:101` ALWAYS 2b, `:307` Plan Sparring Gate heading, `:314-316` rule 51, `:341` IF–THEN 1.
- `b4ed7891a` (#4239, VTID-05280): removed the old §4.1 `**Step 0 (VTID-04868): spar the plan first.**` paragraph
  and added the §4.1 text above in the same commit.
- `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:37-38`: `services/gateway/**` triggers the staging deploy.
- Evidence and staging-suite pattern: `origin/main:docs/validation/VTID-05265/` (a test-only gateway lane:
  `acceptance.md`, `commands.log`, `outputs/*.txt`, `staging-tests.json`).
## Decisions
- **Which text to pin:** the §4.1 sentence, because line 42 guards the §4 allocation procedure (the "puts allocation
  after sparring" half of the test title); rule 51 is already pinned at `:36`. ALWAYS 2b (`:101`) is a second copy of
  the rule, not the §4 procedure.
- **Matcher:** `toContain` with the literal sentence, bold markers and the `(Part 1 rules 51–55)` cross-reference,
  all on one line (`CLAUDE.md:498`). A literal match is the same class as the old regex (which had no wildcards).
  Pinning past `: owner` would tie the test to the next line's wrapping, which a reflow could break with no rule
  change.
- **Comment:** one line above the assertion naming VTID-05280 and §4.1, in the style of the existing comments at
  `:32-35` and `:38`.
- **Encoding:** the file stays UTF-8; `–` is U+2013, as in CLAUDE.md.
