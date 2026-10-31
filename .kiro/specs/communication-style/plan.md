---
change_class: standard
---
# plan(communication-style): how agents talk to the owner, as an always-included steering rule in both repos
Author: Kiro, seat `jtadic`, session `kiro-jtadic-202610300910-8748` (Kiro Web). Repos: `exafyltd/vitana-platform`
and `exafyltd/vitana-v1`. Premises pinned to vitana-platform `origin/main` `4de4e62c28` and vitana-v1 `origin/main`
`847a9f686`. Detail per lane: `tasks.md`; lane files: `lanes/platform-style.md`, `lanes/v1-style.md`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-30 (Kiro Web session): *"Please adopt the following communication style immediately and save it as
persistent, always-included steering. Communicate like a friendly, capable product-building partner, similar to the
conversational feel of Lovable. [...] Keep all existing engineering checks, safeguards, and review rules. These
instructions change communication style only."* The full owner text (tone, depth, how to present work, collaboration)
is carried into the steering file section by section.

## 2. Today
- Neither repo has a rule on how agents talk to the owner: `grep -rni "lovable\|communication style" .kiro/steering/`
  matches nothing in vitana-platform `4de4e62c28` or vitana-v1 `847a9f686`.
- The owner's preference exists only as an account learning, which reaches sessions of one account and is guidance only.
- Kiro Web loads repository steering through `scripts/collab/kiro-web-steering.mjs` (VTID-05339): every
  vitana-platform `.kiro/steering/*.md` is copied; a vitana-v1 file byte-identical to the platform file of the same
  name and without `#[[file:]]` is written once. Kiro IDE reads each repo's `.kiro/steering/` directly. A session
  with only one repo cloned reads only that repo's steering, so the rule must exist in both (same reasoning as plan
  `session-title-stable`).
- `.kiro/steering/**` is a governance path (`scripts/collab/queue.mjs` `GOVERNANCE_PATHS`); an `executor: kiro` lane
  may change it with `reviewer_seat: agent:vitana-lane-reviewer`. It is not a protected gate file
  (`scripts/collab/protected-gate-files.json`).
- PR-GATE "Kiro steering" runs `node --test scripts/ci/kiro-steering/guard.test.cjs` and `guard.cjs .` in both repos.

## 3. Change — two lanes, one per repo, no shared file
Both lanes add the same new file `.kiro/steering/vitana-communication-style.md` (byte-identical in both repos, no
`#[[file:]]`, front matter `inclusion: always`) with the owner's rule in four sections (Tone and style, Depth, How to
present work, Collaboration) and a closing section "What this rule does not change": the rule changes communication
style only; every check, safeguard, review rule and stop case stays; content a rule requires (session id in the first
reply, the five parts of a stop message, the Gate 2 evidence) is still given, told in this style, with identifiers in
a short "Details" part at the end when they would interrupt the story.
- **Lane `platform-style`** (vitana-platform): the steering file, one test appended to
  `scripts/ci/kiro-steering/guard.test.cjs`, evidence `docs/validation/VTID-*/**`.
- **Lane `v1-style`** (vitana-v1): the same file and the same test in vitana-v1's `guard.test.cjs`, evidence.
No dependency between the lanes; they run in parallel.

## 4. Tests (written first, recorded red on each repo's `origin/main`)
One `node:test` case per repo in `scripts/ci/kiro-steering/guard.test.cjs` reading the real file: it exists; front
matter is `inclusion: always`; it has the four owner sections and the "What this rule does not change" section; it
names planned, implemented, tested and live; it keeps the safeguards ("changes communication style only", "stop
message", "Gate 2"); no `#[[file:`. Red on base: the file is missing. Run `node --test
scripts/ci/kiro-steering/guard.test.cjs` and `node scripts/ci/kiro-steering/guard.cjs .`; in vitana-platform also
`kiro-web-steering.mjs` then `--check` on the session workspace.

## 5. Unchanged
`CLAUDE.md`, `.claude/**`, every other steering file, `.kiro/pipeline/**`, hooks, workflows, protected gate files,
every stop case and every content requirement of Gate 2 and stop messages. Deploys nothing (no staging deploy workflow
watches these paths): no STAGING-VERIFY, no Gate 2; done when both lanes are merged green.

## 6. Risks
- Style guidance could be read as permission to drop required evidence. Mitigated by the explicit "does not change"
  section and the test pinning it.
- Two copies can drift. Both tests pin the same structure; the file says to change both together.
<!-- plan:end -->
