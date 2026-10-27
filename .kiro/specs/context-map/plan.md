---
change_class: standard
---
# plan(context-map): one read-only command and one linked page to find code, rules, routes, tests and prior work
Author: Kiro, seat `jtadic`, session `kiro-jtadic-202610271221-c93f` (Kiro Web). Repo: `exafyltd/vitana-platform`
only (reads vitana-v1, writes nothing there). Premises pinned to `origin/main` `80b39e236b`. Detail: `tasks.md`; lane
file `lanes/context-cli.md`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-27 (Kiro Web): *"Investigate how to make Kiro understand our codebase faster and with fewer mistakes
across all future sessions … Propose and, where independent of ongoing work, implement a concise, maintainable way to
find the right context quickly. Use existing tools where they work, keep information linked to its source, and make it
easy to detect stale information … Avoid duplicating large amounts of documentation or creating a second source of
truth."* Another session (plan `kiro-web-reliability`, PR #4392) owns Kiro session setup, steering, hooks, guards and
preflight; this plan touches none of them.

## 2. Today (measured in this Kiro Web session, `80b39e236b`)
1. **The answers exist but are scattered and unindexed for sessions.** Routes: the mount table in
   `services/gateway/src/index.ts` (301 `mountRouterSync` calls, e.g. `:787` `/api/v1/vtid`) plus 412 route files.
   Areas: `services/gateway/src/orb/developer/domain-atlas.ts` (route files, code, tables, flags and docs per domain;
   route claims drift-guarded by `test/vtid-04560-role-separation-regression.test.ts:523`), used only by the developer
   Vitana, not by sessions. v1 screens: `src/App.tsx` (2375 lines, 440 `<Route>`), `screens.json` (207 KB),
   `screen-manifest.json`, `apps/mobile/parity/ledger.json`. Prior work: git, `.kiro/specs/` (40 + 4 specs),
   `docs/validation/<VTID>/` (937 + 257 folders). Rules/decisions: `CLAUDE.md`, `.claude/rules/*.md` (141 KB),
   `docs/CHANGELOG*.md`.
2. **Repeated investigation.** Across the 33 `plan.md` files in both repos, the same files are rediscovered and
   re-cited plan after plan: `scripts/collab/queue.mjs` (11 plans), `protected-gate-files.json` (10), `plan-spar.mjs`
   (8), `PR-GATE.yml` (8), `collaboration.md` (7), `STAGING-VERIFY.yml` (6), `guard.cjs` (6).
3. **Prior-work lookup fails by default in Kiro Web.** `scripts/dev/resume-vtid.sh:20-23` needs
   `DEV_MEMORY_PACK_TOKEN`, which is unset here (`kiro-web-session.mjs status`); the same facts for merged work are in
   git but need five commands across two repos.
4. **RepoWise/Graphify (the recommended tools, `CLAUDE.md:603`) work as CLI only, late, and miss exact lookups.** The
   code-intelligence install took 436 s in the foreground; started detached (`kiro-web-session.mjs:543-544`) it never
   got past `setup start` in this session (`~/.cache/vitana-kiro-web/setup.log`), because the background job did not
   survive the tool call. Once built: `graphify explain "assistant-profile.ts"` lists importers with `file:line` (6.2 s,
   good); `repowise context` gives hotspot/bug-fix history (1.7 s, good); `repowise search "vtid allocate route
   handler"` (full-text only, semantic unavailable) did not return `routes/vtid.ts` (4.0 s); `graphify query
   … --budget 800` returned 18 of 624 unrelated nodes; `repowise decision list` shows auto-mined `proposed` fragments.
5. **Stale or misleading context that sessions load.**
   - `domain-atlas.ts` code pointers that match nothing: `:72` `services/governance-*.ts`, `:108`
     `services/cognee-extractor-client.ts`, `:120` `services/connect-people-*.ts`, `:144` `services/vitana-index*.ts`,
     `:156` `services/commerce/`, `:168` `services/wallet*.ts` and `services/stripe*.ts`, `:191` `services/erp-*.ts`.
     The drift test checks only route claims.
   - `.claude/CLAUDE.md:9` in both repos (inlined into every Kiro Web session as steering): "Last indexed 2026-09-19
     (commit 076aea1 / aa26481)", 779 / 438 commits behind HEAD, and "Trust the index" instructions for MCP tools
     Kiro Web does not have.
   - `.claude/rules/backend.md:1302` names `services/gateway/src/services/cognee-extractor-client.ts`, which exists in
     neither checkout. (`:769` `session/live-session-controller.ts` is a short form of a live file,
     `services/gateway/src/orb/live/session/live-session-controller.ts`: not stale, sparring R1-F1.)
   - `docs/CODEINTEL-SESSION-SETUP.md:3`, `docs/AGENT-REGISTRY.md:94` and `.kiro/pipeline/planning.md:23` still cite
     the "Mandatory Codebase Intelligence Workflow", removed by VTID-05280.
   - `second-brain/` (332 files): copies of docs in `raw/` and a wiki last edited 2026-10-03; a second source of truth
     from before the AWS rules.
   - vitana-v1 `CLAUDE.md` states "App.tsx (1200+ lines)" and "551+ screens"; actual 2375 lines, 365 page files.

## 3. Change (one lane, `context-cli`)
1. **`scripts/dev/context.mjs`**: node, no dependencies, read-only, git-only. It reads the sources of truth live and
   prints `file:line` links. It copies nothing:
   - `route "<METHOD> <path>"`: mount (`index.ts:<line>`) → router file → the most specific handler `file:line`
     (literal path before `:param` before `*`), the atlas domain, tests naming the path or the route file.
   - `screen <path>` (vitana-v1): `App.tsx:<line>` → page file (lazy import resolved), redirects, `screens.json` /
     `exclusions.json` / `screen-manifest.json` / parity-ledger entries, tests naming the path.
   - `domain <word>`: the `domain-atlas.ts` entry (by key, title or alias) with the route files its patterns claim.
   - `uses <file>`: static importers resolved to the file (code vs tests), rule files naming it; points to
     `graphify explain` when the graph exists.
   - `why <term>`: hits in `CLAUDE.md`, `AGENTS.md`, `.claude/rules/*.md`, changelogs, `docs/decisions/`,
     `.repowise/decisions.yaml` (both repos), rules ranked first, each with its section heading.
   - `vtid <VTID>` (`--prs`): commits in both repos (all refs), spec/lane files with `state:`, the validation folder,
     changelog/rule lines; `--prs` adds `gh api search/issues`; the ledger row stays `resume-vtid.sh`.
   - `check` (`--strict`): stale-link report. Atlas code/doc pointers that match nothing and route patterns that claim
     no file; dead paths in the rule files sessions load (both repos); the `.claude/CLAUDE.md` "Last indexed" stamp and
     the local RepoWise/Graphify state versus HEAD; and `docs/CONTEXT-MAP.md`'s own links and command names. Only the
     context map's own problems are errors (exit 1). Everything else is a warning, and `--strict` fails on warnings too.
     Without a vitana-v1 checkout (CI), links written `vitana-v1/<path>` are info.
     **Path resolution** (R1-F1): a backticked token with a `/` and a file extension is a candidate path. Placeholders
     (`<…>`, `$…`, `~`) and generated output (`graphify-out/`, `node_modules/`, `dist/`, `.agents/`) are skipped. The
     token is resolved, in order, (a) as `vitana-platform/<p>` or `vitana-v1/<p>` when it carries that prefix,
     (b) against each repo root and its usual bases (`services/gateway`, `services/gateway/src`, `src`), with `*`/`**`
     globbing, (c) as a suffix of any tracked file in either repo (`git ls-files`, so `session/live-session-controller.ts`
     resolves to `services/gateway/src/orb/live/session/live-session-controller.ts`). Only a token that matches none of
     these is reported dead.
   - `--json` everywhere; `--v1 <dir>` / `VITANA_V1_DIR`; sibling `../vitana-v1` by default.
2. **`docs/CONTEXT-MAP.md`** (about 45 lines): question → first command → source of truth → what detects drift; when
   RepoWise/Graphify help (the measurements in §2.4); what is *not* a source of truth (`second-brain/`, the REPOWISE
   block, `.kiro/specs/**` history). Links only.
3. **`scripts/dev/context.test.mjs`**: unit tests on fixtures plus live checks on this repo, including "CONTEXT-MAP
   has no dead link". `UNIT.yml:17-20` already runs every `scripts/**/*.test.mjs` on every PR, so no workflow changes.

Not in this plan (decisions taken, reported as follow-ups): fixing the atlas pointers (§2.5; it is gateway code read
by the developer Vitana, so it deploys and needs its own staging suite); editing `.claude/CLAUDE.md`, `CLAUDE.md`,
steering, hooks, `.kiro/pipeline/**` or session setup (other session / protected gate file); retiring `second-brain/`
(an owner call); making sessions load `CONTEXT-MAP.md` automatically. That is one line in the steering owned by
`kiro-web-reliability`, which this plan does not edit.

## 4. Lanes
| lane | repo | paths | depends_on |
|---|---|---|---|
| `context-cli` | vitana-platform | `scripts/dev/context.mjs`, `scripts/dev/context.test.mjs`, `docs/CONTEXT-MAP.md`, `docs/validation/VTID-*/**` | — |
A small task: one lane, three files, no fan-out. No shared or hot file with any open plan. `kiro-web-reliability`
edits `scripts/collab/**`, `AGENTS.md`, `.kiro/pipeline/driver.md`, `docs/kiro-web-parity/**`. Only
`docs/programs/standalone/program.md` (this plan PR's program entry) is also touched by #4392; whichever merges second
merges `origin/main` first.

## 5. Tests and commands
- Red on base: `node --test scripts/dev/context.test.mjs` on `origin/main` fails (`context.mjs` missing).
- Green on head: tests for mount/handler/atlas parsing, glob, dead refs incl. the three resolution steps (a short-form
  path to a live file is not dead, a full path to a deleted file is), specifier resolution, `route`/`domain`/`why`/`vtid`
  on a **fixture git repo built in a temp dir** (not on this repo's own files, R1-F2), `check` errors vs info vs
  warnings, CLI exit codes, v1 discovery; also in a `--depth 1` clone without vitana-v1 (as in CI).
- The one test that reads this repo's real files is "`docs/CONTEXT-MAP.md` has no dead link and names only real
  commands" (R1-F2). It fails only on a PR that removes or renames a file the map links to, which is the PR that must
  update the link. This is the same contract as the atlas drift test (`vtid-04560…:523`).
- `node scripts/dev/context.mjs check` exits 0 on the lane head with vitana-v1 present.
- Preflight on the lane head; `UNIT` and PR-GATE green.

## 6. Measurement (evidence `docs/validation/<VTID>/outputs/`)
Benchmark `bench-context-map.sh`: seven representative questions (gateway route, v1 screen, area map, dependencies,
decision, prior work, stale pointers). For each it records commands, wall time, bytes printed (the context an agent
reads) and whether the expected `file:line` appears. It compares grep/git used *with the locations already known*
against one `context.mjs` call. Measured: 20 → 6 commands (−70 %), 82 219 → 9 442 bytes (−89 %), every answer found,
each call ≤ 1.3 s. T7 (stale pointers) has no equivalent today. RepoWise/Graphify answer only after a 436 s build, and
repowise search misses T1. Reported against the real session: this investigation took about 25 exploratory tool calls
before the tool existed.

## 7. Risks
- Regex parsing of `index.ts` / `App.tsx` misses an unusual mount or route form → the command says "no route" and
  names the grep fallback; unit tests pin every form found on `main` today.
- Blast radius in `UNIT` (no path filter, R1-F2): command tests use fixture repos, so renaming `routes/vtid.ts` or a
  spec breaks nothing. Only the context-map link test reads real files. It fails on the PR that breaks a link, and its
  message names the link and the line.
- `check` warnings are noisy if treated as gates; only the context map's own links are errors.

## 8. Unchanged
Every rule, steering, hook, guard, preflight, workflow, `CLAUDE.md`, `.claude/**`, the atlas, the gateway, vitana-v1.
Nothing deploys.
<!-- plan:end -->
