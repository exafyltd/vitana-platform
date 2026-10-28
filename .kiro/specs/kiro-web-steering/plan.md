---
change_class: standard
---
# plan(kiro-web-steering): Kiro Web sessions load the repositories' steering and the pipeline driver
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202610261510-099d` (Kiro Web). Repo: `exafyltd/vitana-platform`
only. Premises pinned to `origin/main` `55cc5bbadc`. Detail per lane: `tasks.md`; lane file: `lanes/web-steering.md`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-26 (Kiro Web session): *"Please make the autonomy setup durable, so it works in every new sandbox
without me repeating instructions."* … *"Implement and commit a supported setup that loads the correct repository
rules in new workspaces. If automatic setup is unavailable, document the exact one-time startup step."* … *"Check that
the referenced steering files and pipeline driver are actually read and followed. Merely mentioning their paths in a
bridge file is not enough."* … *"Keep the existing explicit stop conditions, including migration approval, unchanged
for now."* No rule text changes: this plan changes how the existing rules reach a Kiro Web session, not the rules.

## 2. Today
Observed in this session, Kiro Web, 2026-10-26: the workspace root is `/projects/sandbox`; both repos are cloned
beneath it (`/projects/sandbox/vitana-platform`, `/projects/sandbox/vitana-v1`); `/projects/sandbox/.kiro/` held only
an empty `settings/`. None of the repos' always-included steering (`vitana-load-project-rules.md`,
`vitana-kiro-notes.md`, `vitana-standing-rules.md` → `CLAUDE.md`) was in the session's context, and the session asked
the owner for approvals the rules forbid asking. A steering file written to `/projects/sandbox/.kiro/steering/` with
`inclusion: always` and `#[[file:vitana-platform/<path>]]` references was loaded on the next turn with every
referenced file inlined in full.
Documented (kiro.dev): workspace steering lives in `<project root>/.kiro/steering/`, and `#[[file:…]]` paths
resolve relative to the workspace root (docs/steering); Kiro Web says it reads steering from the root of each cloned
repository (docs/steering, Web tab), but that did not happen in this session; AGENTS.md is discovered in
subdirectories (docs/steering); Kiro Web runs no hooks, so `.kiro/hooks/*.json` never runs there (docs/hooks,
docs/hooks/types); user-level steering reaches cloud sessions only through Configuration Sync (docs/web/cloud-configuration).
Nested `.kiro/` discovery and recursive `#[[file:]]` resolution are not documented.

Repo, verified at `55cc5bbadc`:
- `.kiro/steering/vitana-pipeline.md:9` — "Kiro Web (no workflow engine): follow `.kiro/pipeline/driver.md`"; it has
  no front matter (Kiro default `always`). No steering file `#[[file:]]`-links `driver.md`, `common-rules.md` or
  `planning.md` (`grep -n '#\[\[file' .kiro/steering/*.md`: only backend, collaboration, infrastructure,
  standing-rules); `scripts/ci/kiro-steering/guard.cjs:112` treats `driver.md` as a text-only reference.
- Steering `#[[file:]]` paths are repo-relative (`.kiro/steering/vitana-standing-rules.md:9,11`); `fileMatchPattern`
  globs are repo-relative (`.kiro/steering/vitana-collaboration.md:2-5`). Both are wrong when resolved from a
  workspace root one level above the repo.
- `.kiro/hooks/vitana-pipeline-start.json` (SessionStart) is the IDE's start trigger; it cannot run in Kiro Web.
- `scripts/collab/queue.mjs:85` lists `scripts/collab/**` as a governance path; `:231-234` lets an `executor: kiro`
  lane with `reviewer_seat: agent:vitana-lane-reviewer` change one that is not a protected gate file
  (`scripts/collab/protected-gate-files.json` does not list the new files).
- `.github/workflows/PR-GATE.yml:140` runs `node --test scripts/collab/*.test.mjs` (Collab tests).
- `AGENTS.md` holds only the Codex repository-scope rule (`AGENTS.md:1-15`); identical in vitana-v1. Several
  runtimes read it (Codex, Kiro, others).
- Observed after a first generated set was written (same session): the always-included files loaded with their links
  inlined, but Kiro cut the last inlined link (`vitana-platform/.claude/CLAUDE.md`) with "Truncated steering
  reference … read the file". The total always set with links is ~123 KB. An inline size cap exists; its value is not
  documented.

## 3. Change — one lane `web-steering` (vitana-platform)
**Lane file** (`lanes/web-steering.md`): `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer` (the two
`scripts/collab/` files are a governance path, `queue.mjs:85`, which an `executor: kiro` lane may change only with the
reviewer agent, `queue.mjs:231-234`), `seat: exafyltd`, `paths`: `scripts/collab/kiro-web-steering.mjs`,
`scripts/collab/kiro-web-steering.test.mjs`, `AGENTS.md`, `docs/kiro/**`, `docs/validation/VTID-*/**`. None matches a
glob in `scripts/collab/protected-gate-files.json` (checked: that list names `queue.mjs`, `plan-spar.mjs`,
`protected-gate-files.json` under `scripts/collab/`, plus `CLAUDE.md`, workflows, gateway and migration files).
**A. Generator `scripts/collab/kiro-web-steering.mjs`** (Node ≥ 20, no dependencies, ESM, exports its functions):
`node vitana-platform/scripts/collab/kiro-web-steering.mjs [--workspace <dir>] [--check] [--json]`.
1. Workspace = `--workspace`, else the parent directory of the repository that contains the script. Repos = direct
   children of the workspace that are git checkouts whose `origin` is `exafyltd/vitana-platform` or
   `exafyltd/vitana-v1` and have `.kiro/steering/`. Prefix = the child folder name.
2. For each repo steering file `<name>.md`, write `<workspace>/.kiro/steering/<prefix>--<name>.md`: the same front
   matter with each `fileMatchPattern` glob prefixed `<prefix>/`, `inclusion` unchanged (absent stays absent), then a
   marker line `<!-- generated by vitana-platform/scripts/collab/kiro-web-steering.mjs from <prefix>/.kiro/steering/<name>.md @ <short sha>; do not edit -->`,
   then the body with every `#[[file:X]]` rewritten to `#[[file:<prefix>/X]]`. Nothing else in the body changes.
3. A vitana-v1 file byte-identical to the vitana-platform file of the same name and without `#[[file:]]` is not
   written twice (the platform copy covers it); every other file of each repo is written.
4. One extra file `<workspace>/.kiro/steering/vitana-platform--kiro-web-driver.md`, `inclusion: always`, stating that
   on Kiro Web `vitana-pipeline.md` names `.kiro/pipeline/driver.md` as the runbook, and linking
   `#[[file:vitana-platform/.kiro/pipeline/driver.md]]`, `…/common-rules.md` and `…/planning.md` so their text is in
   context, not just their paths.
5. Files under `<workspace>/.kiro/steering/` carrying the marker but no longer produced are removed; files without the
   marker are never touched. Nothing is written inside either repository.
6. `--check` writes nothing and exits 1 listing every problem: a generated file missing or different from what it
   would write now; a `#[[file:]]` in a generated file that does not resolve from the workspace root; a linked file
   that itself contains `#[[file:]]` (recursive resolution is undocumented, so a nested link is reported, not
   assumed). Exit 0 prints the file list with byte counts.
**B. `AGENTS.md`** — a section "Kiro Web: load the Vitana steering", appended under the existing Codex rule (which
stays verbatim). Its first sentence scopes it: it applies only to a Kiro Web session (a Kiro session whose workspace
root is the folder the repos are cloned into); Codex, Claude Code and Kiro IDE sessions ignore it. Then: when
`<workspace>/.kiro/steering/vitana-platform--vitana-load-project-rules.md` is missing, run
`node vitana-platform/scripts/collab/kiro-web-steering.mjs` before anything else, then follow the loaded rules.
**A7.** The run output and `--json` report the byte total of the always-included set with links inlined, so a
truncation risk is visible; the doc (C) says a truncated inlined file must be read in full with a file read (the
truncation notice says the same).
**C. `docs/kiro/kiro-web-bootstrap.md`** — what is documented vs observed vs assumed (with kiro.dev URLs); the
supported setup: (1) the one-time Configuration Sync upload of `docs/kiro/cloud-config/vitana-kiro-web-bootstrap.md`
as a user-level steering file (persists across sandboxes), (2) AGENTS.md as the in-repo trigger, (3) the exact
first-message fallback line; how to verify a session loaded the rules (`--check` exit 0 and the session stating its
session id as `vitana-load-project-rules.md` requires); Autonomous mode is a session toggle and is not required.
**D. `docs/kiro/cloud-config/vitana-kiro-web-bootstrap.md`** — the user-level steering file (`inclusion: always`):
on Kiro Web, if the generated files are missing, run the generator, then follow them.

## 4. Tests (`scripts/collab/kiro-web-steering.test.mjs`, `node:test`, temp fixture workspaces)
Written first and recorded red on `origin/main` (the module does not exist there).
1. `#[[file:]]` and `fileMatchPattern` globs are prefixed; front matter stays the first content; `inclusion` kept.
2. A v1 file identical to the platform file and without links is written once; a differing one is written per repo.
3. The driver file exists, is `always`, and links driver.md, common-rules.md, planning.md.
4. A stale marked file is removed; an unmarked user file in the same folder is untouched; nothing is written in a repo.
5. `--check`: exit 0 after a run; exit 1 on a missing link target, a stale file, and a nested `#[[file:]]`.
6. Against the real checkouts (`--workspace` = the CI checkout's parent when both repos exist, else one repo):
   `--check` after a run is clean. Run: `node --test scripts/collab/*.test.mjs` (PR-GATE.yml:140).

## 5. Unchanged
Every rule file (`CLAUDE.md`, `.claude/**`, `.kiro/steering/**`, `.kiro/pipeline/**`, `.kiro/hooks/**`), every stop
case (Gate 2, escalated sparring verdict, migration-file approval §7d, the §7 stop cases), protected gate files, the
IDE workflow. Deploys nothing (no staging deploy workflow watches these paths), so no Gate 2: done when merged green.

## 6. Risks
- Context size: the always set grows by vitana-v1's `CLAUDE.md` (27.5 KB) and `.claude/CLAUDE.md` (8.8 KB), the same
  load a multi-root IDE workspace carries (each root's always files). Kiro truncates past an undocumented cap (seen on
  the last file, `vitana-platform/.claude/CLAUDE.md`, a generated RepoWise index, not rule text). Accepted: the rule
  files (`CLAUDE.md` Part 1, steering, driver) came through whole; the byte total is reported (A7) and the doc names
  the read-in-full fallback. No file is dropped or reordered to fit, because that would change which rules load.
- Kiro Web may start loading repo-root steering as documented; then rules load twice with different paths. The
  generated copies stay equivalent, so behaviour is the same; the doc names this.
- The Configuration Sync upload is an owner action in the Kiro UI; Kiro cannot do it. Until it is done, AGENTS.md and
  the first-message line are the triggers.
<!-- plan:end -->
