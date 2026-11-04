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

**Acceptance**
- Change types: Tooling/docs.
- Outcome: any fresh Kiro or Claude session in either repository loads the end-to-end rule and the one complete stop table
  without the owner restating it; CI fails if a section or a stop is dropped.
- States: a section deleted (guard fails); the file made optional (guard fails); the two repositories drifting (the evidence
  shows equal hashes; the next edit of either copy must update both).
- Surfaces: the steering file, the guard and its test, one doc paragraph. No product code.
- Locales: n/a. Accessibility: n/a.
- Contract: `rule-text.md` is copied byte for byte; the 13 stop rows and their 16 existing anchors are untouched.
- Staging proof: not verified on staging: steering text and a CI guard deploy nothing. Proof: the guard tests and the
  generator check.
- No rule is weakened; nothing is added to the stop table; `vitana-pipeline.md`, `AGENTS.md` and `CLAUDE.md` are not edited.
