# Tasks — e2e-autonomy
Authoritative plan: `plan.md`. VTID from CI PLAN-SPAR. Branch `kiro/e2e-autonomy/steering`; PR titles
`VTID-xxxxx (e2e-autonomy/steering): …` (one PR per repository, same VTID); trailers `Collab-Session` and
`Collab-Lane: e2e-autonomy/steering`; identity `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`.

<!-- lane: steering -->
## Lane `steering` (vitana-platform and vitana-v1)
- [ ] S1 In `scripts/ci/kiro-steering/guard.test.cjs`: change the anchor-count test from 16 to 27; record the new anchor tests
      red on base.
- [ ] S2 Copy `rule-text.md` unchanged to `.kiro/steering/vitana-owner-autonomy.md` in both repositories.
- [ ] S3 Add the eleven text anchors to `OWNER_AUTONOMY_TEXT_ANCHORS` in `scripts/ci/kiro-steering/guard.cjs` (both repositories):
      `Primary operating principle`, `Default execution sequence`, `When Kiro may interrupt the owner`, `Reviewer autonomy`,
      `CI autonomy`, `Staging autonomy`, `Production boundary`, `Fresh-session behavior`, `Communication style`,
      `Definition of done`, `the stricter rule applies`.
- [ ] S4 Platform only: one paragraph in `docs/kiro/kiro-web-bootstrap.md` under "Autonomy: one rule for every task".
- [ ] S5 Evidence: tests red then green in both repositories; `sha256sum` of the steering file in both (equal);
      `node vitana-platform/scripts/collab/kiro-web-steering.mjs --check` ending `kiro-web-steering: ok` with the byte size
      before and after.
- [ ] S6 The body of the vitana-v1 PR states, with the lines of plan §4: stop row 3 there changes from "a Claude review … or an
      owner instruction" to "the owner's instruction plus a reviewer-agent accept" (a tightening, authority
      `collaboration.md` §3a/§7b on the platform's `main`), and that vitana-v1's `.claude/rules/collaboration.md` still carries
      the older reading at lines 132 and 253 and lags by 27 lines. The platform PR body links to it.

**Acceptance**
- Change types: Tooling/docs.
- Outcome: any fresh Kiro or Claude session in either repository loads the end-to-end rule and the one complete stop table
  without the owner restating it; CI fails if a section or a stop is dropped.
- States: a section deleted (guard fails); the file made optional (guard fails); the two repositories drifting (the evidence
  shows equal hashes; the next edit of either copy must update both).
- Surfaces: the steering file, the guard and its test, one doc paragraph. No product code.
- Locales: n/a. Accessibility: n/a.
- Contract: `rule-text.md` is copied byte for byte; the 13 stop rows keep their meaning and their 16 existing anchors, except
  that row 3 in vitana-v1 becomes the platform's wording (a tightening, plan §4).
- Staging proof: not verified on staging: steering text and a CI guard deploy nothing. Proof: the guard tests and the
  generator check.
- No rule is weakened (row 3 in vitana-v1 is tightened, on the authority named in plan §4); nothing is added to the stop table;
  `vitana-pipeline.md`, `AGENTS.md`, `CLAUDE.md` and vitana-v1's `collaboration.md` are not edited.
