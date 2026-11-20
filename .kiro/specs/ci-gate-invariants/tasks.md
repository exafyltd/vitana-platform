# Tasks — ci-gate-invariants

One PR per lane. The lane `bootstrap-pack-rules` lives in `exafyltd/vitana-platform`, so its branch is
`kiro/ci-gate-invariants/bootstrap-pack-rules` and its title is `VTID-05792 (ci-gate-invariants/bootstrap-pack-rules): …`,
with the trailers `Collab-Session` and `Collab-Lane`. The lane changes only its `paths`. VTIDs are assigned by CI after
PLAN-SPAR converges. Do not start the lane before its `vtid:` is set. No existing test is edited.

## Operator bootstrap pack — rules start at PART 1
<!-- lane: bootstrap-pack-rules -->
- [ ] B1 Write `services/gateway/test/vtid-05792-bootstrap-pack-rules.test.ts` first. Read the real `CLAUDE.md` as
  `vtid-04018-operator-bootstrap-pack.test.ts` does. Four cases: (a) `extractClaudeMdPart1(real)` starts with
  `# PART 1: CORE RULES`; (b) it does not contain the Autonomy Contract heading (`AUTONOMY CONTRACT`); (c) it does not
  contain `# PART 2`; (d) when the text has no `# PART 1`, the output is the file start, bounded as before. Cases (a)
  and (b) must fail on `origin/main`. Record the red run in the lane log.
- [ ] B2 In `services/gateway/src/services/operator-bootstrap-pack.ts`, change `extractClaudeMdPart1` (`:114-117`) to
  start at the first `# PART 1` (fall back to 0 when the marker is missing), cut at `# PART 2` as before, and clip at
  `LIMITS.rulesChars` as before. Update its doc comment. No other function changes.
- [ ] B3 Run both test files: `cd services/gateway && npx jest test/vtid-04018-operator-bootstrap-pack.test.ts test/vtid-05792-bootstrap-pack-rules.test.ts`.
  Both pass. Then run the full gateway suite once to catch a second test that reads the rules.
- [ ] B4 Write `docs/validation/VTID-05792/evidence.md`: the red and green Jest output, the full-suite result, and the
  flag state (`OPERATOR_BOOTSTRAP_PACK_ENABLED` is off by default, `operator-bootstrap-pack.ts:73`), so staging is not
  a proof of this change.

Acceptance:
- Change types: Backend, Tooling/docs
- Outcome: the operator's rules section begins at CLAUDE.md PART 1. The rules are the same text as before, without the
  preamble (Autonomy Contract). Operators with the flag off see no difference.
- States: no `# PART 1` in the file → the output is the file start, bounded by the same budget.
- Surfaces: n/a: no UI.
- Locales: n/a: developer-facing text in English only.
- Accessibility: n/a: no UI.
- Contract: `extractClaudeMdPart1(text, maxChars)` keeps its signature and budget. The output loses the preamble, which is the one behaviour change; `file:line` at `operator-bootstrap-pack.ts:114-117`.
- Staging proof: not verified on staging. The pack is off unless `OPERATOR_BOOTSTRAP_PACK_ENABLED=true`, so the unit tests B1 and B3 are the proof.
