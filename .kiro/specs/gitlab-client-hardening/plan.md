---
change_class: standard
---
# Plan: gitlab-client hardening (lane gitlab-client follow-up, items 28–31)

change class: standard (scripts/**, test files, a validation harness)
scope: vitana/vitana-platform only. Files: `scripts/eng/gitlab-api.mjs`, `scripts/eng/gitlab-api.test.mjs`,
  `docs/validation/VTID-05537/outputs/mutate-gitlab-client.sh`, `docs/validation/VTID-05537/acceptance.md`,
  `docs/validation/VTID-05537/commands.log`. No change to other lanes' files. No production or live write.
evidence: code excerpts in `gitlab-api-evidence.md` in this scratchpad (read from GitLab `vitana/vitana-platform` `main`).

<!-- plan:begin -->
## Problem
1. `scripts/eng/gitlab-api.mjs` puts the caller's path into errors and `GitLabApiError.path` without redaction.
   Redaction (`redact`) covers response bodies and messages, not the path. The path check (`PATH_OK`) accepts every
   character a GitLab token uses (`[A-Za-z0-9_.~=-]`), so a path that contains a token passes the check and is echoed
   into `GitLabApiError.message`, `.path`, and log events (`prepare`, `execute`, `failureFor`, `decode`, `paginate`).
   The module's header claims the token "is not in any error", so the claim does not hold for paths.
2. `docs/validation/VTID-05537/outputs/mutate-gitlab-client.sh` line 173 (mutant "error path keeps the query") has an
   unescaped `${...}` inside its perl replacement. The mutant made an empty-URL change, not the named one, so its
   "caught" result does not test the named behaviour.
3. `acceptance.md:28` says a per-test red is not available; a stub module gives one. The header's "no URL escaping"
   remark is inexact: `=` and `~` are URL-encoded (`%3D`, `%7E`). The PR body still states the old counts.

## Change
1. **Refuse token-bearing paths.** In `prepare()`, which is defined inside `createClient` and so closes over `secret`
   (the configured token), refuse before anything is sent a path that contains `secret`, or that matches a non-global copy
   of `TOKEN_SHAPE` or `BEARER`. The module-level regexes carry the `g` flag, so `.test()` on them is stateful: the check
   uses `path.search(PATH_TOKEN_SHAPE) !== -1` with `PATH_TOKEN_SHAPE = new RegExp(TOKEN_SHAPE.source, 'i')` and
   `PATH_BEARER = new RegExp(BEARER.source, 'i')`, both without `g`. `redact()` is unchanged, since `replace` ignores
   `lastIndex`. `serializeQuery` is module-private and called only from `prepare()` (verified in the evidence), so it needs
   no check of its own. Error: code `bad_path`, message
   `the path contains a credential; send credentials in the client's token option, never in a path`. The message and the
   `path` field carry no part of the path. `paginate()` runs the same check before its first `checkNumber` / `badRequest`,
   because those messages include the path too.
   `request()` runs the same check at its top, before its `okStatuses` argument check, because `request()` builds its error with
   the raw path before it reaches `prepare()` (round 1, R1-F1).
2. **Test first.** In `gitlab-api.test.mjs`: (a) a path containing the token → rejects with `code: 'bad_path'`, and the
   same call is made twice in a row, both rejected (this exposes any stateful `.test()`); the message,
   `JSON.stringify(err)`, and `err.path` contain no token; the injected fetch is never called. (b) the same through
   `paginate()`. (c) a path that merely contains `glpat-` followed by 10 characters is refused. (e) `request('GET', <token-bearing path>, { okStatuses: [404] })` rejects with `code: 'bad_path'`, and the error holds no part of the path. (d) a normal path such as
   `/projects/1/merge_requests` still passes. Record (a)–(c) red on `origin/main` in `commands.log` before the code.
3. **Mutation harness.** Rewrite the perl replacement of "error path keeps the query" so its `${...}` is escaped and it
   changes the URL line only. Re-run the harness. Add one mutant for item 1: removing the path check makes (a) red.
4. **Correct the evidence.** `acceptance.md:28`: a per-test red is available through a stub module; cite the stub run.
   Header lines 18 and 205: state that `=` and `~` are URL-encoded. Update the counts in `acceptance.md`,
   `commands.log` and the PR body from the re-run.

## Not in scope
- Changing any other check, retry rule, status mapping or the public API.
- Merge-bot, github-bridge, gateway-delivery and settings lane items (items 24–27, 32, 33 of the owner's list).
- Any production write, GitLab project setting change, token rotation or deploy.

## Verification of the change
- `node --test scripts/eng/gitlab-api.test.mjs` and `node --test scripts/eng/` green, with the new cases red before the code.
- The mutation harness re-run: every named mutant caught, including the new path-refusal mutant; the counts match the log.
- `git diff --stat`: only the five files above change.

## Rollback
Revert the commit. No runtime behaviour outside the client changes.
<!-- plan:end -->

## Planner responses (round 1)
- **F1 (major) stateful `g`-flag regexes — ACCEPTED.** Change 1 now uses non-global copies and `String.search`, and test (a)
  calls the check twice. `redact()` is unchanged.
- **F2 (minor) where `prepare()` gets the token — ACCEPTED, answered.** `prepare()` is defined inside `createClient` and
  closes over `secret`, so the containment check reads `secret` directly.
- **F3 (minor) single call hides the `g` bug — ACCEPTED.** Test (a) now runs twice in a row.
- **F4 (minor) `serializeQuery` reachable outside `prepare()` — ACCEPTED, answered.** It is module-private and called only
  from `prepare()` (evidence excerpt). No separate check.
- **F5 (minor) unverifiable claims (`acceptance.md:28`, header lines, owner's list) — ACCEPTED as unverified.** Those
  files are not in the evidence; the implementer checks them before editing.
