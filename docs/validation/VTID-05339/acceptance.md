# VTID-05339 acceptance (kiro-web-steering/web-steering, tasks.md T1-T5)

Every AC below is checked by the reviewer agent against the PR diff. Each maps to a TEST: within 12 lines.
Red-on-base output: `red-on-base.txt` (copy in `outputs/`). Full command log and pass/fail counts: `commands.log`.

AC-1 `scripts/collab/kiro-web-steering.mjs` mirrors every `.kiro/steering/*.md` of each Vitana checkout under the
workspace into `<workspace>/.kiro/steering/<repo>--<name>.md`, prefixing `#[[file:]]` links and `fileMatchPattern`
globs with the repo folder, keeping front matter first and `inclusion` unchanged; an identical link-free vitana-v1 file
is written once (plan §3 A1-A3, §4 cases 1-2).
TEST: node --test scripts/collab/kiro-web-steering.test.mjs

AC-2 It adds `vitana-platform--kiro-web-driver.md` (`inclusion: always`) linking `.kiro/pipeline/driver.md`,
`common-rules.md` and `planning.md`; it removes only stale files carrying its marker and writes nothing inside a repo
(plan §3 A4-A5, §4 cases 3-4).
TEST: node --test scripts/collab/kiro-web-steering.test.mjs

AC-3 `--check` writes nothing and exits 1 on a missing or stale generated file, an unresolved link or a nested link;
on the real checkouts it is clean after a run; a known checkout without `.kiro/steering/` is skipped with a note
(plan §3 A6-A7, §4 cases 5-6, R2-F1).
TEST: node --test scripts/collab/kiro-web-steering.test.mjs
TEST: node scripts/collab/kiro-web-steering.mjs --workspace /projects/sandbox --check

AC-4 `AGENTS.md` keeps the Codex rule byte-identical and appends a section scoped to Kiro Web only; the docs separate
documented, observed and assumed behaviour and leave every owner stop unchanged (plan §3 B-D).
TEST: node --test scripts/collab/*.test.mjs
