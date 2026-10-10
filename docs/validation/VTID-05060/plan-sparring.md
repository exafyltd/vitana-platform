# Plan B — "Resume a VTID" handoff for Kiro IDE, Command Hub Operator and Claude Code, plus keeping the developer's Kiro model pick

<!-- plan:begin -->
## Problem
The owner wants to pick up work started in a Claude Code session and continue it in Kiro IDE or in the Command Hub
Operator (Kiro engine). A conversation's transcript cannot move between tools. What exists today:
- `GET /api/v1/dev-memory/morning-pack` (`routes/dev-memory.ts:70`, VTID-04408): latest Operator handoffs, last week's
  knowledge, in-progress VTIDs — per owner, not per VTID. Pack-token or admin read.
- Operator thread handoff notes (`services/dev-memory/handoff.ts`, VTID-04407) — only for Operator threads; a Claude
  Code session writes none.
- Kiro model picker per thread (`kiro-turn.ts:267-277`, routes `operator.ts:854/861`, VTID-04984) — manual, per
  thread; a new session opens on Kiro's default model.
Missing: one place that turns a VTID into a "here is where it stands, here is what's next" start prompt.

## Change (change class: standard — a new read route, a new Operator tool, one Kiro session default)
1. `services/dev-memory/resume-pack.ts` (new) — `buildResumePack(vtid)`; read-only, every section fails open with the
   reason (same pattern as morning-pack.ts):
   - ledger row: title, summary, status, spec_status, is_terminal, metadata.plan_hash / sparring_record;
   - PRs for the VTID in both repos: ONE call to GitHub's `/search/issues?q=VTID-NNNNN in:title type:pr
     repo:exafyltd/vitana-platform repo:exafyltd/vitana-v1` through a NEW `searchPullRequests` wrapper in
     github-service.ts (none exists today), with state, head branch, merge commit and PR body (first 1,500 chars);
   - evidence files `docs/validation/<VTID>/` (names; `acceptance.md` and the plan block of `plan-sparring.md`, each
     capped) via `getFileContents` on main, else the PR head branch;
   - live handoff notes / knowledge rows in dev_agent_memory tagged with the VTID;
   - deploy state: staging and production `/api/v1/admin/build-info` commit (gateway GETs, not GitHub), and whether
     the merge commit is an ancestor of each via a NEW `isAncestor(repo, commit, ref)` helper in resume-pack.ts
     (compare API: `behind`/`identical` = ancestor) — read-only GETs only.
   GitHub budget per pack: 1 search + 1 evidence listing + 2 evidence files + 2 compares = 6 calls, 8s timeout each,
   token `GITHUB_SAFE_MERGE_TOKEN` (unset → those sections `unavailable` with the reason, as morning-pack does).
   The built pack is cached in memory 60s per VTID, so repeated starts do not re-hit GitHub (search API 30/min).
   Output `{ok, pack:{sections…, unavailable[], text, instructions}}`; `text` capped at 8k chars. `instructions` is a
   SEPARATE field (fixed English: continue this VTID, follow the repo's standing rules, do not re-allocate a VTID,
   Gate 2 only from STAGING-VERIFY) — the shell script prints it, the Operator tool omits it.
   Admin-facing, English by design.
2. `GET /api/v1/dev-memory/resume/:vtid` on the existing dev-memory router, same `requireDevMemoryAccess` (pack token
   or admin), `VTID-\d{5}` validated → 400 otherwise, 404 when the ledger has no row.
3. Operator tool `dev_resume_vtid({vtid})` in gemini-operator (read-only tool class) returning the pack text (no
   instructions field), so the Operator / Kiro can be told "resume VTID-05047" in a fresh thread. Exposed to Kiro
   through the existing MCP tool bridge like the other read tools. Added as a scenario to the operator pipeline
   regression suite (rule 42f).
4. `scripts/dev/resume-vtid.sh <VTID>` (vitana-platform only, next to the route; Kiro IDE on vitana-v1 runs it from
   the platform checkout) — curl the route with `DEV_MEMORY_PACK_TOKEN`, print the text, for
   Kiro IDE (paste into chat) and for any Claude Code session. Never fails loudly on missing token (prints why).
5. Claude Code → handoff: extend nothing new; instead the resume pack reads what a session already leaves behind
   (ledger, PR, evidence, branch). A session that stops mid-flight is told (CLAUDE.md one line) to put "Where it
   stopped / Open / Next" in its PR body — the pack shows the PR body's first 1,500 chars. Best-effort by design:
   no CI check; a body without it just shows what is there. The existing `.github/pull_request_template.md` gets an
   optional "Handoff (where it stopped / open / next)" section so sessions see the prompt.
6. The developer's model choice is kept (owner decision 2026-10-10: the developer selects the model — Auto or any
   model in Kiro's own drop-down; no server-side default, no env setting). The drop-down already exists and lists
   exactly what Kiro offers (VTID-04984: `listKiroModels`/`setKiroModel`, `operator.ts:854/861`, Command Hub
   `state.kiroModels`), and every pick is already recorded as the OASIS event `operator.kiro.model_selected`
   `{thread_id, model_id}` (`operator.ts:869-879`). Gap: a Kiro session closes after 15 min idle, a deploy, or the
   55-min reopen, and the new session silently starts on Kiro's default — the developer's pick is lost. Change: inside
   `runKiroTurn`, right after a NEW session is stored for a thread, read that thread's latest
   `operator.kiro.model_selected` event (owner's own, newest first, 1 row); if Kiro's freshly offered list contains
   that model id, re-apply it through the same client call `setKiroModel` uses; if Kiro no longer offers it, leave
   Kiro's current model and set `kiro_model_restore: 'unavailable:<id>'` in that turn's `KiroTurnResult` meta, so the
   badge shows the real model and the reason (never silent). No pick on record → Kiro's own default (Auto when Kiro
   offers it), unchanged.

## Risk
- New read route exposing ledger/PR/evidence text: same audience as the morning pack (pack token or exafy_admin).
- GitHub API calls per request: capped (≤ 6 calls), 8s timeout each, fail open.

## Tests
- `test/vtid-NNNNN-resume-pack.test.ts`: pack built from fake ledger/GitHub/memory; each section fails open; text cap;
  route 400/401/403/404/200; pack-token read works; no write calls.
- Operator tool test: `dev_resume_vtid` registered, read-only class, returns text.
- Model choice restore: new session + pick on record + still offered → re-applied; no longer offered → Kiro's model
  kept + meta flag; no pick on record → no call; existing (not new) session → no lookup.
- Operator pipeline regression suite stays green (rule 42e).
- Staging (read-only, unauthenticated only): `GET /api/v1/dev-memory/resume/VTID-05047` → 401;
  `GET /api/v1/dev-memory/resume/not-a-vtid` → 401 (auth before validation). The 200 path is covered by unit tests.
<!-- plan:end -->

## Planner responses — round 1
- F1 [minor] — ACCEPTED: a new `searchPullRequests` wrapper is named as new code.
- F2 [major] — ACCEPTED: one multi-repo search call (not two); budget recounted to 6 GitHub calls; 60s per-VTID cache;
  token and unset behaviour stated.
- F3 [major] — ACCEPTED: insertion point is in `runKiroTurn` after the session is stored, thread id known.
- F4 [minor] — ACCEPTED: script in vitana-platform only.
- F5 [minor] — ACCEPTED: `instructions` is a separate field; Operator tool omits it, script prints it.
- F6 [major] — ACCEPTED: new `isAncestor` helper in resume-pack.ts, named as new code.
- F7 [minor] — ACCEPTED: new scenario in the operator pipeline regression suite.
- F8 [minor] — ACCEPTED: best-effort, stated in the plan; the existing `.github/pull_request_template.md` gets an
  optional handoff section.
- Q1: `/search/issues` with both `repo:` qualifiers. Q2: `KiroTurnResult` meta. Q3: staging probes are 401-only and
  need no existing VTID; VTID-05047 exists in the shared ledger regardless.

## Round 2 (partner verdict: CONVERGED) — all findings closed, no new findings.

## Owner change after Gate 1 (2026-10-10), round 3
Owner: "The developer selects the model. The developer can select Auto … or pick a model from the model drop down
list … exact the same drop down Kiro offers." Item 6 (env `KIRO_PREFERRED_MODEL`) is removed and replaced by keeping
the developer's own pick across Kiro session reopens. Owner decision — not re-argued; only the implementation is sparred.

## Round 3 (partner verdict: CONVERGED) — item 6 replacement verified against operator.ts:869-879 and kiro-turn.ts:211; no new findings.

## Approval
Plan hash: b8f99bd87e2dbfef (sha256 of the plan:begin..plan:end block, first 16 hex). Verdict: CONVERGED (round 3, after the owner replaced item 6).
Owner approval: 2026-10-10, Gate 1 "Yes". VTID allocated after approval: VTID-05060.
