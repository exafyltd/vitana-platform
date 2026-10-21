# Removed / condensed / kept — per changed file (VTID-05280)

Per-removal detail and flag rows: `diff-review.md`. Token evidence: `must-keep-check.txt`. Numbering:
`duplicate-labels.txt`. External references: `xref-sweep.md`.

## `CLAUDE.md` (1021 → 612 lines)

| Section | Removed | Condensed | Kept (substance) |
|---|---|---|---|
| Header | — | "Last Updated" → 2026-10-20 | title, "read before changes" |
| GCP banner (D) | history of the decommission night, Polly Russian-voice explanation, "see CHANGE LOG" prose | 35 → 9 lines | `lovable-vitana-vers1` dead; all on AWS; sr/ru Vertex bridge (`VERTEX_SERBIAN_BRIDGE_ENABLED`, `VERTEX_RUSSIAN_BRIDGE_ENABLED`) and sr/ru audiobook TTS (`AUDIOBOOK_GOOGLE_RU_ENABLED`, `AUDIOBOOK_GOOGLE_SR_ENABLED`, `AUDIOBOOK_GOOGLE_DAILY_CHAR_CAP_PER_TASK`) on a dedicated project; window ~2026-12-16, review 2026-12-06; own switch + predicate, never a list; code defaults may still fall back to Google (§2c–§2e) → check before touching GCP refs; pointer to backend.md |
| Autonomy contract (L) | — | re-wrapped to 118 columns | every sentence; added pointer "IF–THEN 26" to the scoping rule |
| Collaboration (M) | "one Kiro account reviews another's lane" (outdated) | roles rewritten against collaboration.md §7–§7b | git-only channel, queue, session id, claim, lane file; Kiro plans/builds/reviews; reviewer agent `vitana-lane-reviewer` accepts; CI spars + allocates; PM merges under §7b (staging-only, plan driver while PM not live); Claude Code optional/exceptions; protected gate files need legacy Claude or owner review; Kiro never deploys to prod or writes live systems |
| Part 1 intro (J) | — | — | added: sections numbered separately, numbers stable, retired-number index |
| ALWAYS 1–7, 2b (A, I) | ALWAYS 3, 8, 9, 10 | 2b rewritten: allocation only after sparring + approval (Gate 1 or `converged-auto-v1`), Kiro VTIDs from CI | 1, 2, 4–7; never ask the user about VTIDs; one VTID per piece of work; set approved/in_progress on instructed work |
| ALWAYS 10a–10c (L, F, G) | Anthropic error-text quote, "33 in one day" | incident to one "why" clause | Bedrock only, never `anthropic`, no-credit silent fallback, never fail back to Google |
| ALWAYS 11–22 infra (A, B) | ALWAYS 18, 19, 21–22 (infra) | 20–22 → one ALWAYS 20 (grep before build, curl after, `text/html` = not live, never assume success) | 11–17 (account/region, dynamic resolution, ECR, `/alive`, 8080, live task def, CI deploys only) |
| ALWAYS 21–30 database | — | 28 gains "tenant context missing → do not proceed" (folded IF–THEN memory 18) | all ten rules |
| ALWAYS 31–40 frontend (H) | 32–34 | 31–34 → one ALWAYS 31 sidebar rule; 40 gains "failing accessibility check blocks the release" | 35–40 (ORB voice-first, CSP, local JS, layout regions, Markdown specs, WCAG 2.2 AA) |
| NEVER 1–40 (A, H, I, G) | 2, 5, 6, 18, 19, 20, 21–23, 31, 32, 37, 40 | NEVER 1 parallel-period VTID list → one clause; NEVER 27 + IF–THEN 25 → "add screens only when asked, register per v1 rules"; NEVER 38 absorbs 2 + 40 | 1, 3, 4, 7–17, 24–30, 33–36, 38, 39 |
| Rules 41–42 spoken wording (L, G) | "Nova drops ~10% of sessions" detail | incident → one clause | intent-not-sentence rule, `FLEXIBLE WORDING — ABSOLUTE`, the STOP rule, speech-only scope, `tt()` catalog |
| Rules 42a–42h (L) | — | re-wrapped; 42c list tightened | persona genders + `persona-voice-gender.ts` test; Devon no-male-voice rule; support/operator/role suites with `test:support`, `test:operator`, `test:roles`, coverage lists, fix-the-change and add-a-scenario rules |
| Rules 43–45 (L, G) | 445-DM narrative detail, owner quote, deletion-pass counts | incidents → one clause each | invisibility rule; register in both `service_bot_accounts` and `notification_test_actors` before insert; registering later is cleanup; surfaces must exclude both allowlists like `fire_welcome_chat_on_membership()` |
| Rules 46–50 (L) | — | re-wrapped; 48 "(rules 31–32)" → "(IF–THEN 31–32)" | full staging gate |
| Rules 51–55 (L) | — | re-wrapped; added "There is no trivial-change exemption" | full sparring gate, partner chain, DB gate, break-glass |
| IF–THEN 1–2 (I) | "self-allocate immediately" | allocation after sparring + approval; Kiro from CI | stop only on allocation failure; never ask the user; set approved on instructed work |
| IF–THEN 3–15 | — | — | all |
| IF–THEN 16–20 deploy (B) | 16–19 (merged into ALWAYS 20), 20 `git reset --hard` deleted | — | — |
| Visual verification (C) | settings-page code example (pointed at production), per-element step list, "20 pages" rule as its own number | ~40 → 8 lines | every step; WSL2 tip; curl fallback; new i18n-test allowance |
| Test account 31/31b/32 + auth snippet (C, L) | 960/600 narrative detail | one "why" clause | one Supabase project, no writes on any host, community content absolute, blocker-not-workaround, suppression is not a licence; full auth snippet with `sb-inmkhvwdcuyhnxkgfvsb-auth-token` |
| CI/CD 21–26 (E) | 8 Jun 2026 time-gated framing; dead GCP `STAGE-DEPLOY.yml` history; `publish-to-prod.sh` as a production route | rule 26 ~45 → 12 lines | staging-only auto deploys (`cutover_gate`), PUBLISH or pinned recorded-reason manual dispatch; `AWS-STAGE-DEPLOY-GATEWAY.yml` + `preview-aws-gateway.vitanaland.com`; no "to be safe" dispatch; worker-runner/orb-agent/autopilot manual-only; `?v=` bump; rule 26: session-scoped, `expected_commit`/`commit_sha`, never the defaults, never `publish-to-prod.sh --ref` (branch/tag only, wraps dead `EXEC-DEPLOY.yml`), full snapshot incl. ancestors, diff vs `/api/v1/admin/build-info`, STOP and tell the user, PUBLISH needs no scoping |
| IF–THEN memory 16–20, frontend 21–25 (A, H, I) | all ten | 18 → ALWAYS 28, 24 → ALWAYS 40, 21 → ALWAYS 31, 25 → NEVER 27 | — |
| IF–THEN AI 26–31 (D, F, J) | AI 26 (folded into ALWAYS 10a), Gemini Pro/Flash history | AI-27 points at the banner instead of re-explaining | AI-27 LLM-routing Google ban (absolute), new language = new switch/predicate/VTID; AI-28 validation via Bedrock; AI-29 logging (+ folded ALWAYS 18); AI-30 TTS `model_name`; AI-31 `BEDROCK_ROLE_ARN` ordering |
| Retired-number index (J) | — | new | every retired number → where it lives |
| Part 2 pointers (L, G) | relocation explanation prose | 26 → 13 lines | both pointer lists, §4/§5 unscoped |
| §4 VTID (I, L, G) | "first step, no exceptions" | 4.1 intro rewritten (allocation after sparring + approval; Kiro via CI); criterion-5 incident → one clause | procedure 1–7 (gateway with `GATEWAY_SERVICE_TOKEN`/`exafy_admin`, RPC, atomic mint, title update, allocator-disabled stop, one per piece, resume-vtid), format, target roles + INFRA exclusive, lifecycle, eligibility incl. criterion 5, two-planes table, allowlist `isAutonomousExecutionTask()`, `autonomous_execution`, no `ANTHROPIC_API_KEY` on worker-runner |
| §5 Governance (L) | — | — | switches `EXECUTION_DISARMED`/`AUTOPILOT_LOOP_ENABLED`/`VTID_ALLOCATOR_ENABLED`, rules 4–6, endpoints, `X-BYPASS-ORCHESTRATOR` |
| CHANGE LOG pointer (G) | relocation prose | 7 → 2 lines | both changelog files |
| Codebase intelligence + graphify (K) | mandatory freshness check, mandatory code map, no-broad-grep ban, mandatory re-index, duplicate graphify section | 89 → 11 lines, **recommended** (weakened on purpose, see `diff-review.md`) | tool list, source/tests final authority, `graphify update .`, `graphify claude install` |

## `.kiro/steering/vitana-kiro-notes.md` (23 → 19 lines)

| Removed | Condensed | Kept |
|---|---|---|
| "(about 1,000 lines)"; the session-start bullet (duplicated in `vitana-load-project-rules.md` §4 and `collaboration.md` §4) | role bullet points at `collaboration.md` §7–§7b as the single source of truth; adds "merge except under §7b" to the never list | sparring via `plan(` PR + CI (and "never left only in this chat"), resume-vtid, path-scoped rules, roles, §7a never-list (no hand VTIDs, no prod deploy, no live writes, no self-accept), pipeline entry point |

## `.kiro/steering/vitana-load-project-rules.md` (26 → 26 lines)

| Removed | Condensed | Kept |
|---|---|---|
| role sentence duplicated from `vitana-kiro-notes.md` | step 2 points at `vitana-kiro-notes.md` + `collaboration.md` §7–§7b | files to read; migration-file rule; fix-forward/park/Claude-only-if-available; **NOT read-only**, never test against production; step 4 now carries the session-start commands once (session id with `--seat`, fetch, queue, claim, driver); account-level copies note |
