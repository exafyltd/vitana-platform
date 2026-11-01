# Requirements — I18N-PROPAGATE must never write stale locale files over newer translations

Author: kiro (session `kiro-202610152203-0347`). Drafted 2026-10-16. Code lives in **exafyltd/vitana-v1**; the spec
lives in vitana-platform because PLAN-SPAR only runs on vitana-platform PRs (collaboration §2, spans-repo rule).

## Context

On PR exafyltd/vitana-v1#1399 (branch `claude/vitanaland-desktop-redesign-kv8059`) the `I18N-PROPAGATE` workflow
(workflow id 328950926, run 38443615525) committed `6b698ac98` at 23:14Z, which put English placeholders back over the
human translations committed 15 minutes earlier in `2f5c0cbf4` (22:59Z) for
`spotlightMember.settings.preferences.{desc,accessibilityNote}` in nine locales. A human had to re-apply them in
`ab05df942`. Root cause and evidence: `plan.md`.

## Requirement 1 — Only the bot's own changes are written

**User story:** As a developer translating a string by hand on a PR branch, I want the propagation bot to keep my
commit, so that I never have to re-apply my work after a bot run.

1.1 WHEN the `collect` job writes translated locales THEN the system SHALL apply only the keys the fan-out changed
    relative to the commit the fan-out started from, never whole files or whole locale directories.
1.2 WHEN a key was changed on the branch after the fan-out started AND the fan-out did not change that key THEN the
    system SHALL keep the branch's value.
1.3 WHEN a key was changed both on the branch after the fan-out started AND by the fan-out THEN the system SHALL keep the
    branch's (human) value and SHALL emit a `::warning::` naming the locale, file and key.
1.4 WHEN the fan-out adds a key, deletes a key, or creates a shard file that the branch did not touch THEN the system
    SHALL apply that addition, deletion or creation.
1.5 WHEN a shard file was deleted on the branch after the fan-out started THEN the system SHALL NOT recreate it.
1.6 The same rules SHALL apply to `i18n-source-stamps/<locale>.json`.
1.7 Files the system writes SHALL keep the existing serialisation (`JSON.stringify(x, null, 2) + '\n'` for shards,
    the compact one-line form for stamp files) so an unchanged key produces no diff.

## Requirement 2 — Pushes never swallow a failed rebase

2.1 WHEN the `pivot` or `collect` push is rejected THEN the system SHALL refresh from the remote branch and re-apply its
    own changes on top, and SHALL NOT continue past a failed `git pull --rebase` (`|| true`).
2.2 WHEN five attempts fail THEN the run SHALL fail red.

## Requirement 3 — Proven by CI

3.1 The merge logic SHALL live in a script with `node --test` coverage, including a replay of the PR #1399 sequence.
3.2 The tests SHALL run in the `i18n check` workflow on every PR that changes the script.

## Out of scope

Translation quality, the provider, the matrix, the drift gate, and the 5-hour run length (a cause of the wider race
window, not of the overwrite).
