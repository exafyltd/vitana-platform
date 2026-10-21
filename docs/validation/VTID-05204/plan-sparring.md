# VTID-05204 — Plan sparring record

- **Plan:** Commerce UX contract as a standing rule (docs/rules only, both repos)
- **Change class:** light (2 rule files + evidence packs)
- **Plan hash (sha256, NFC, trailing whitespace stripped, blank runs collapsed, text between the plan markers):**
  `fb79e33c28453c442b9fc296daa01251f6eee6c58168ba19989a6ca96e97beaa`
- **Partner:** `plan-sparring-partner` (independent, read-only), 2 rounds
- **Verdict:** CONVERGED — no blocker or major; all five minor findings and both questions closed
- **Owner approval:** 2026-10-15 in session: Approved.
- **Repos:** `exafyltd/vitana-v1` (`CLAUDE.md`) and `exafyltd/vitana-platform` (`.claude/rules/backend.md`); one VTID for both.
- **Implementation note:** the approved plan uses the placeholder `VTID-XXXXX`; the merged text carries `VTID-05204`
  after allocation. No other wording differs.

## Final plan

<!-- plan:begin -->
## Goal (owner, 2026-10-15)
Make the owner's Commerce UX contract permanent across sessions: one-click / one-step supplier onboarding,
AI-led not form-led, every frontend Commerce PR carries a UX acceptance section, and backend/API design supports
it. Docs/rules only. Keep the rules short enough that future sessions follow them.

Change class: **light** (2 rule files; no code, migrations, routes, auth, `.github`, deploy, governance or
LLM-routing files). Docs-only: nothing deploys to production, so no Gate 2; done when merged with green checks.

## Out of scope (owner)
No code. Country/website inference and "Your assistant can do this" are raised as two separate follow-up plans
after this merges. No PR-template or CI enforcement in this change.

## Change 1 — vitana-v1 `CLAUDE.md` (unscoped, so every session sees it)
New section inserted after "Voice navigation — the screen registry" and before "Key Patterns" (keeps the
Spotlight/Voice page-mechanics pair together), exact wording:

```markdown
## Commerce UX contract — supplier onboarding (VTID-XXXXX)

Owner rule 2026-10-15. Applies to every Commerce supplier screen: `src/components/commerce/**`,
`src/pages/Commerce*.tsx`, and any other partner/supplier onboarding screen.

- **AI-led, not form-led.** The primary path is: the supplier connects their AI assistant, says "Set up my
  business on Vitanaland", and Vitanaland + the assistant do everything that can safely be automated. Manual
  onboarding is the fallback and must never make the AI path more complex.
- **Before adding any field, step, dialog or status**, ask: does the supplier really need to see or provide it?
  If Vitanaland can infer it, the AI can provide it, the supplier already gave it, or it can wait — don't ask now.
  Never ask twice for the same information.
- **One dominant action per screen.** Plain business language; no technical or internal concepts (IDs, connector
  names, step keys, lifecycle states) in normal supplier UX. Progressive disclosure only.
- **A human is required only for:** legal acceptance, identity/verification, payment/bank details, destructive
  actions and final sensitive confirmations.
- **Every frontend Commerce PR has a "UX acceptance" section:** user steps · required fields · decisions ·
  anything asked that Vitanaland or the AI could infer (must be "none" or justified) · can the user always tell
  what to do next · friction up or down vs. before.
- **A change that increases onboarding friction needs explicit owner approval** before merge.
```

## Change 2 — vitana-platform `.claude/rules/backend.md` §13c-infra
Loaded whenever a session touches `services/gateway/**` (all Commerce routes/services live there). Appended as
rule 9 of "Standing rules for any Commerce change", exact wording:

```markdown
9. **The API serves the AI-led, low-friction onboarding UX (VTID-XXXXX, owner rule 2026-10-15).** The
   frontend contract lives in `exafyltd/vitana-v1` `CLAUDE.md` → "Commerce UX contract".
   - Never require a field from the client just because an internal model has it: infer it, default it, or
     let the connected AI supply it; require it only when it is legally or operationally necessary.
   - Onboarding status keeps stable, human-facing checklist semantics. Any new or changed status field must
     say, per open step, whether the system/AI can complete it or a human must (legal acceptance,
     identity/verification, payment/bank details, destructive actions, final sensitive confirmations).
   - Return plain business concepts to the client, not internal implementation terms.
```

## Verification
- Both files render; no other content changes (`git diff --stat` = 1 file per repo plus evidence pack).
- vitana-v1: PR-GATE scope.json kind `docs`, paths `["CLAUDE.md", "docs/validation/<VTID>/**"]` (CLAUDE.md is not
  in ALWAYS_ALLOWED); i18n/lint unaffected. vitana-platform: VALIDATOR-CHECK body fields +
  `docs/validation/<VTID>/` evidence pack (acceptance.md, commands.log, outputs/); the same VALIDATOR fields
  already passed for docs/rules-only platform PRs this week — confirmed on the first push.
- No staging test is meaningful for a rules-only change; acceptance = the exact text above is merged.

## Follow-ups (separate plans after merge)
1. Profile sheet: infer country/website (from website / registration / AI) and only ask what cannot be inferred.
2. "Still needed": mark AI-completable steps "Your assistant can do this" (needs the per-step flag rule 9
   requires for new status fields; today's checklist has no such flag).
3. Optional: CI/PR-template enforcement of the "UX acceptance" section (advisory only until then, like the
   What's New rule).
<!-- plan:end -->

## Round 1 — partner findings (verbatim)

## Verified premises

- **"Spotlight Design Contract" section exists in vitana-v1 CLAUDE.md and the new section would be inserted after it** → TRUE — `/home/user/vitana-v1/CLAUDE.md:317`. The section runs from line 317 to 325; what follows is "Voice navigation" (line 327), then "Key Patterns" (line 338). The plan says "after Spotlight Design Contract" which is a valid insertion point, though it would land between two existing sections.

- **backend.md §13c has "Standing rules for any Commerce change" ending at rule 8, so rule 9 can be appended** → TRUE — `/home/user/vitana-platform/.claude/rules/backend.md:1022` lists "Standing rules for any Commerce change:" with rules 1-8 ending at line 1069. The section boundary (`---` at line 1071) is the natural end, so appending rule 9 before that separator is correct.

- **backend.md is scoped to `services/gateway/**` and Commerce routes live there** → TRUE — `/home/user/vitana-platform/.claude/rules/backend.md:3` has `paths: - services/gateway/src/**` and Commerce routes exist at e.g. `/home/user/vitana-platform/services/gateway/src/routes/partner-onboarding.ts`, `/home/user/vitana-platform/services/gateway/src/routes/commerce-mcp.ts`.

- **vitana-v1 CLAUDE.md is unscoped (no `paths:` front-matter) so every session sees it** → TRUE — `/home/user/vitana-v1/CLAUDE.md` has no YAML front-matter; it is loaded unconditionally as the project root CLAUDE.md.

## Findings

F1 [minor] Insertion point "after Spotlight Design Contract" places a Commerce-specific standing rule between two layout/navigation contracts, breaking topical grouping
Evidence: `/home/user/vitana-v1/CLAUDE.md:317-337` — Spotlight Design Contract (VTID-05107) is followed by Voice Navigation (VTID-04502), both about screen/page mechanics. Inserting Commerce UX between them splits that cluster.
Suggestion: Insert the Commerce UX contract section after "Voice navigation — the screen registry" (after line 336) and before "Key Patterns" (line 338), or better yet after "What's New cards" (which is the last feature-specific standing rule) to keep the page-mechanics pair together. The exact placement is cosmetic but the plan should name the correct anchor.

F2 [minor] Rule text references `src/pages/Commerce*` but several Commerce pages use different naming
Evidence: `/home/user/vitana-v1/src/pages/CommercePortal.tsx`, `CommerceJoin.tsx`, `CommerceTeam.tsx`, `CommerceHealthOrders.tsx`, `CommerceConnectDocs.tsx`, `CommerceConnectPrivacy.tsx`, `CommerceConnectAuthorize.tsx`, `CommerceConnectionRedirect.tsx`, `CommerceAcceptInvite.tsx` — the glob `src/pages/Commerce*` correctly catches all of these, but the rule text also says "partner/supplier screens" without specifying paths. Any new screen under a different path prefix (e.g. a hypothetical `src/pages/Supplier*.tsx` or `src/pages/Partner*.tsx`) would not be covered by the explicit glob but might be covered by the vague "partner/supplier screens" clause.
Suggestion: Either enumerate the additional path patterns or keep just the text "partner/supplier screens" without pretending it is a glob. This is cosmetic -- the rule is advisory to sessions, not CI-enforced -- but clarity helps.

F3 [minor] The "UX acceptance" section requirement in the plan has no CI enforcement and the plan explicitly excludes it ("No PR-template or CI enforcement in this change")
Evidence: Plan lines 13-14 declare "No PR-template or CI enforcement in this change." The rule in Change 1 says "Every frontend Commerce PR has a 'UX acceptance' section" but compliance depends entirely on the implementing session reading and following the rule text. This is consistent with how other standing rules work (e.g. the What's New cards rule at `/home/user/vitana-v1/CLAUDE.md:295`), so it is not a blocker, but worth noting that compliance is advisory only.
Suggestion: Acknowledge this explicitly in the plan or in the follow-up list: CI enforcement of the UX acceptance section is a natural third follow-up.

F4 [minor] Plan says "scope.json kind `docs`" for the vitana-v1 PR, which is valid but CLAUDE.md is not in ALWAYS_ALLOWED
Evidence: `/home/user/vitana-v1/scripts/ci/pr-gate/lib.mjs:39-48` — `ALWAYS_ALLOWED` does not include `CLAUDE.md`. The scope.json `paths` array must explicitly include `CLAUDE.md` for the PR to pass the scope guard. The plan does not mention this requirement, though an implementer would naturally add it.
Suggestion: Note in the plan that scope.json paths must include `"CLAUDE.md"` (root-level, no glob) or the PR-GATE scope guard will reject the change.

F5 [minor] The plan mentions "VALIDATOR-CHECK body fields" for vitana-platform but this is a docs-only change to `.claude/rules/backend.md` -- verify that VALIDATOR-CHECK does not reject rule-file-only PRs
Evidence: The plan does not specify what VALIDATOR-CHECK expects for a PR that only touches `.claude/rules/backend.md` plus the evidence pack. This is a low risk since rule files are not code, but the implementer should confirm CI is compatible.
Suggestion: Verify VALIDATOR-CHECK handles `.claude/rules/**` changes gracefully, or note the expected CI behavior.

## Questions for the planner

1. The plan says the new section in vitana-v1 CLAUDE.md goes "after Spotlight Design Contract" -- should it go after the full cluster of standing-rule sections (after "What's New cards" at line 295, or after "Voice navigation" at line 327) to avoid splitting the page-mechanics pair? This is cosmetic but the plan should be precise about the anchor since the exact wording matters for CLAUDE.md.

2. The backend rule 9 text says "Onboarding status uses stable, human-facing checklist semantics, and marks each open step as completable by the system/AI or requiring the human" -- is this describing an existing API contract or prescribing a future one? If it is prescriptive, does it conflict with the current `partner_onboarding_status` endpoint's response shape? (I did not check the endpoint implementation since this is docs-only, but the rule might create confusion if the current API does not match.)

## Verdict

CONVERGED — No blockers or majors. All five findings are minor (cosmetic/clarity). The plan is well-scoped: two rule-text insertions, no code, no deploy, no governance changes. The factual premises all check out. The only action items are clarifying the exact insertion point and noting scope.json path requirements for the implementer.

## Round 1 — planner responses

- F1 ACCEPTED — section moves to after "Voice navigation", before "Key Patterns".
- F2 ACCEPTED — scope sentence now names `src/components/commerce/**`, `src/pages/Commerce*.tsx`, then
  "any other partner/supplier onboarding screen" as plain text, not a pseudo-glob.
- F3 ACCEPTED — added follow-up 3 (CI/PR-template enforcement); compliance is advisory, as stated.
- F4 ACCEPTED — scope.json paths spelled out, including root `CLAUDE.md`.
- F5 ACCEPTED — evidence pack included; VALIDATOR compatibility confirmed on first push.
- Q1 — answered by F1.
- Q2 — prescriptive, not descriptive: rule 9 now says "any new or changed status field must say…". Today's
  checklist has no per-step machine/human flag; follow-up 2 is where it gets added. No conflict with the current
  endpoint, which this change does not touch.

## Round 2 — partner re-review (verbatim)

## Round 1 findings — status

- F1 [minor] Insertion point splits page-mechanics pair → **closed** — plan revised to insert after "Voice navigation", before "Key Patterns" (line 17-18). Verified: `/home/user/vitana-v1/CLAUDE.md:336-338` confirms the gap exists.
- F2 [minor] Vague path references → **closed** — rule text now names explicit paths plus plain-text catch-all (lines 23-24).
- F3 [minor] No CI enforcement of UX acceptance section → **closed** — follow-up 3 added (line 69).
- F4 [minor] CLAUDE.md not in ALWAYS_ALLOWED → **closed** — scope.json paths now spelled out including root `CLAUDE.md` (line 59).
- F5 [minor] VALIDATOR-CHECK compatibility unverified → **closed** — planner confirms compatibility from recent precedent (line 62).
- Q1 → **closed** — answered by F1 revision.
- Q2 → **closed** — planner clarifies rule 9 is prescriptive for new/changed fields only; current endpoint is untouched; follow-up 2 is where the flag gets added (lines 81-83).

## Verified premises (round 2 re-check)

- **Insertion point "after Voice navigation, before Key Patterns"** → TRUE — `/home/user/vitana-v1/CLAUDE.md:336-338`: line 336 ends Voice navigation, line 338 starts "## Key Patterns". The new section fits cleanly between them.
- **Rule 9 appends after rule 8 in §13c-infra standing rules** → TRUE — `/home/user/vitana-platform/.claude/rules/backend.md:1069-1071`: rule 8 ends at line 1069, followed by `---` at line 1071. Rule 9 inserts before the separator.
- **scope.json paths `["CLAUDE.md", "docs/validation/<VTID>/**"]`** → TRUE — `/home/user/vitana-v1/scripts/ci/pr-gate/lib.mjs:39-48` confirms CLAUDE.md is not in ALWAYS_ALLOWED, so it must be declared. `docs/validation/<VTID>/**` is auto-allowed per line 51, but including it explicitly is harmless.

## Findings

No new blockers or majors. The revised plan addresses all five round-1 findings. The exact wording, insertion points, verification steps, and follow-up list are all accurate against the current codebase.

## Questions for the planner

None.

## Verdict

CONVERGED — All round-1 findings are closed. No new blocker or major. The plan is ready for Gate 1.

## Verdict

CONVERGED after 2 rounds. Owner approved 2026-10-15 in session ("Approved."), with the scope limited to
`vitana-v1/CLAUDE.md`, `vitana-platform/.claude/rules/backend.md` and the validation records; country/website
inference, "Your assistant can do this" and PR-template enforcement are excluded from this VTID.
