---
change_class: standard
---
# plan(session-title-stable): the session title is set once and never renamed
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202610270811-c79f` (Kiro Web). Repos: `exafyltd/vitana-platform`
and `exafyltd/vitana-v1`. Premises pinned to vitana-platform `origin/main` `eda3ab3ab0` and vitana-v1 `origin/main`
`fb9b6d843`. Detail per lane: `tasks.md`; lane files: `lanes/platform-title.md`, `lanes/v1-title.md`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-27 (Kiro Web session): *"Why do you change the session name during the process, and I lose control
because of that change not knowing what that session is initiated for. Explain how do we fix it so you stop changing
the name and confusing me with the new session titles?"* The owner then had a global Kiro learning saved ("Set the
session title once, based on the user's original request, and never rename it later in the session") and reported a
session on `exafyltd/vitana-v1` still renamed to *"Blocked: PM agent push loop"*. The owner approved adding the same
rule to both repositories' steering, so it loads in every Vitana session from git, not only from the account learning.

## 2. Today
- Neither repo has a rule about the session title: `grep -rni "title" .kiro/steering/` in vitana-platform `eda3ab3ab0`
  and vitana-v1 `fb9b6d843` matches nothing about sessions; `CLAUDE.md` does not mention it either.
- Kiro Web sessions update the session title as work changes focus (observed: the owner's screenshot, title prefixed
  with the state "Blocked:"). The account learning exists since 2026-10-27 but is guidance only and reaches only
  sessions of that account.
- Kiro Web loads repository steering through the generated workspace set (`scripts/collab/kiro-web-steering.mjs`,
  VTID-05339): every `vitana-platform/.kiro/steering/*.md` is copied; a vitana-v1 file byte-identical to the platform
  file of the same name and without `#[[file:]]` is written once (plan `kiro-web-steering` §3 A3). Kiro IDE reads each
  repo's `.kiro/steering/` directly. A session with only vitana-v1 cloned (the screenshot's case) reads only v1's
  steering, so the rule must exist in both repos.
- `.kiro/steering/**` is a governance path (`scripts/collab/queue.mjs` `GOVERNANCE_PATHS`); an `executor: kiro` lane
  may change it with `reviewer_seat: agent:vitana-lane-reviewer`. It is not a protected gate file
  (`scripts/collab/protected-gate-files.json`).
- PR-GATE "Kiro steering" runs `node --test scripts/ci/kiro-steering/guard.test.cjs` and `guard.cjs .` in both repos
  (vitana-platform `.github/workflows/PR-GATE.yml:62-67`, vitana-v1 `.github/workflows/PR-GATE.yml:73-78`).

## 3. Change — two lanes, one per repo, no shared file
Both lanes add the same new file `.kiro/steering/vitana-session-title.md` (byte-identical in both repos, no
`#[[file:]]`, so Kiro Web loads it once) with front matter `inclusion: always` and this rule:
1. Set the session title once, at the start, from the owner's original request (what the session was started for).
2. Never change it later: not when the focus shifts, a sub-task starts or ends, the session is blocked, waiting for
   the owner, or done.
3. Never put a state in the title (no "Blocked:", "Waiting:", "Done:" or similar prefix or suffix). State is reported
   only through the session status (`waiting_on_user`, `completed`) and the session description, which may change.
4. Change the title only when the owner explicitly asks for it in that session.
5. Applies to every Kiro session on Vitana (Kiro Web, Kiro IDE, automation-started drivers).
- **Lane `platform-title`** (vitana-platform): the steering file, one test appended to
  `scripts/ci/kiro-steering/guard.test.cjs`, evidence `docs/validation/VTID-*/**`.
- **Lane `v1-title`** (vitana-v1): the same file and the same test appended to vitana-v1's
  `scripts/ci/kiro-steering/guard.test.cjs`, evidence `docs/validation/VTID-*/**`.
No dependency between the lanes; they run in parallel.

## 4. Tests (written first, recorded red on each repo's `origin/main`)
One `node:test` case per repo in `scripts/ci/kiro-steering/guard.test.cjs`, reading the real repo file: the file
exists; its front matter is `inclusion: always`; the body states set-once (rule 1), never-rename (rule 2), no state in
the title (rule 3, naming "Blocked:"), owner-asks-only (rule 4); it contains no `#[[file:`. Red on base: the file is
missing. Run: `node --test scripts/ci/kiro-steering/guard.test.cjs` and `node scripts/ci/kiro-steering/guard.cjs .`.
In vitana-platform also `node scripts/collab/kiro-web-steering.mjs --check` on the session workspace after a
generator run, showing the file loaded once.

## 5. Unchanged
`CLAUDE.md`, `.claude/**`, every other steering file, `.kiro/pipeline/**`, hooks, workflows, protected gate files,
every stop case. Deploys nothing (no staging deploy workflow watches these paths), so no STAGING-VERIFY and no
Gate 2: done when both lanes are merged green.

## 6. Risks
- A steering rule is guidance to the model, not a lock; a session can still rename. Accepted: it is the only in-repo
  control; the account learning stays as a second source.
- Two copies can drift. The two tests pin the same text; a later change edits both (noted in the file).
<!-- plan:end -->
