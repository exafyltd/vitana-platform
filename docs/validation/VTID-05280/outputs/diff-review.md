# Per-removal review — platform `CLAUDE.md` (VTID-05280, lane claude-md-cleanup/rules-trim)

Checked against the real diff (`git diff origin/main -- CLAUDE.md`). Every retired number of the plan's Removal table
is here; the same mapping is in the file itself (Part 1 "Retired-number index").

## Flag rows (substantive — confirm explicitly)

| Retired | Rule (origin/main) | Disposition | Substance now lives in (branch) |
|---|---|---|---|
| ALWAYS 18 | log provider, model, latency for AI calls | folded | AI-29: "IF an AI call is made → THEN log provider, model and latency; IF model fallback occurs → THEN log it explicitly" |
| NEVER 2 | never bypass governance gates | folded | NEVER 38: "Never bypass, hide or skip a governance gate, a governance failure or a validation step"; IF–THEN 6–7 |
| NEVER 19 | never silence errors | removed, generic | NEVER 35 (no silent model fallback), NEVER 38, ALWAYS 10c |
| NEVER 40 | never bypass validation | folded | NEVER 38 (as above); rule 50 (never skip, disable or loosen a test); AI-28 |
| IF–THEN 16–20 (memory) | retrieve / don't inject / tenant context / write-fail event / schema migrate | removed, generic; 18 folded | ALWAYS 26–29; ALWAYS 28 "Tenant context missing → do not proceed"; ALWAYS 7 (OASIS events); ALWAYS 24 + NEVER 16 (schema docs) |
| IF–THEN 24 (frontend) | accessibility fails → block release | folded | ALWAYS 40: "A failing accessibility check blocks the release" |

## Weakened on purpose (owner instruction 2026-10-20, plan item K, Decision 10)

| Item | Before | After |
|---|---|---|
| Codebase intelligence | "Mandatory Codebase Intelligence Workflow": always query RepoWise + Graphify before any work; mandatory freshness check; mandatory pre-execution code map; no broad grep; mandatory re-index of both indexes after every change; "graphify" section repeats it | "Codebase intelligence (recommended)": use RepoWise/Graphify for unfamiliar or cross-module work; tool list kept (`get_overview`, `search_codebase`, `get_context`, `get_symbol`, `get_why`, `get_risk`; `graphify query/path/explain`, `graphify update .`, `graphify claude install`); kept as a rule: source and tests are the final authority, never invent a relationship |

## All retired numbers

| Retired | Rule | Disposition | Now |
|---|---|---|---|
| ALWAYS 3 | check memory first | removed, generic | ALWAYS 26–29 |
| ALWAYS 8 | assume defense-in-depth | removed, generic | ALWAYS 4, IF–THEN 6–8, §5, rules 46–55 |
| ALWAYS 9 / NEVER 5 | prefer existing systems / never rebuild | removed, generic | — |
| ALWAYS 10 | fail loudly on a missing invariant | removed, generic | NEVER 35, 38; ALWAYS 10c |
| ALWAYS 18 **flag** | log provider/model/latency | folded | AI-29 |
| ALWAYS 19 | CI/CD governed | removed, duplicate | ALWAYS 17, NEVER 17 |
| ALWAYS 21–22 (infra) | verify after deploy / deploy source on `origin/main` | merged | ALWAYS 20 (grep before build, curl after, `text/html` = not live); hand-deploy check unneeded under ALWAYS 17 |
| ALWAYS 32–34 | 10 items, Start Stream utility zone, private AI + screen share | merged | ALWAYS 31 |
| NEVER 2 **flag** | bypass governance gates | folded | NEVER 38 |
| NEVER 6 | assume unverified context | removed, generic | IF–THEN 10 + autonomy contract |
| NEVER 18 | assume deploy success | merged | ALWAYS 20 ("Never assume deployment success without that check") |
| NEVER 19 **flag** | silence errors | removed, generic | NEVER 35, 38; ALWAYS 10c |
| NEVER 20 | auto-fix without root cause | removed, generic | — |
| NEVER 21–23 | Start Stream in sidebar / not Go Live / sidebar navigation | merged | ALWAYS 31 |
| NEVER 31, 32 | hallucinate data / invent memory | removed, generic | ALWAYS 26 |
| NEVER 37 | respond confidently when uncertain | removed, generic | IF–THEN 10 |
| NEVER 40 **flag** | bypass validation | folded | NEVER 38; rule 50; AI-28 |
| IF–THEN 16–19 (deploy) | grep source / curl JSON / `text/html` / compare hand deploy with `origin/main` | merged | ALWAYS 20; ALWAYS 17 (no hand deploys) |
| IF–THEN 20 (deploy) | `git reset --hard origin/main` before deploying | deleted | ALWAYS 17 (deploys go through CI); conflicted with git safety |
| IF–THEN 16–20 (memory) **flag** | see flag rows | removed, generic; 18 folded | ALWAYS 26–29, 28, 7, 24; NEVER 16 |
| IF–THEN 21 (frontend) | sidebar forbidden | merged | ALWAYS 31 ("Changing the sidebar … is forbidden") |
| IF–THEN 22 | JS must be external | removed, duplicate | ALWAYS 36–37, NEVER 24–25 |
| IF–THEN 23 | canon wins | removed, generic | IF–THEN 9 |
| IF–THEN 24 **flag** | accessibility fails → block release | folded | ALWAYS 40 |
| IF–THEN 25 | screen not in inventory → do not add | merged | NEVER 27 (add screens only when asked; register per v1 screen manifest, `screens.json`/`exclusions.json`, parity ledger) |
| IF–THEN 26–30 (visual) | visual verification steps 1–5, never report UI done unchecked, never screenshot 20 pages, WSL2 tip, curl fallback | condensed | "Targeted Visual Verification" paragraph — every step kept (scope to the change, 1400×900 + 390×844, interact, inspect, fix/re-shoot, never report done unchecked, WSL2 line, curl line); new: text-only/i18n change may rely on i18n tests (brief C) |
| IF–THEN 26 (AI) | route Claude at `provider: 'bedrock'` (+ superseded Gemini history) | folded | ALWAYS 10a; Gemini history removed (brief F) |

## Relabelled (same digits)

IF–THEN AI 27–31 → `AI-27`–`AI-31` under the header "cited elsewhere as IF–THEN 27–31", so plain IF–THEN 31/31b/32
stay the test-account rules. External "IF-THEN 31" (Bedrock ordering, `.claude/rules/backend.md` ×4) resolves to AI-31.
