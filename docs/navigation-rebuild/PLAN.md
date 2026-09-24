# ORB User Navigation — Rebuild Plan

Owner-approved 2026-09-24. Program VTIDs: VTID-04496 (Phase 0), later phases
allocate their own.

## Owner decisions

1. **Single source of truth: a screen registry in `exafyltd/vitana-v1`**,
   next to the routes. The Command Hub's navigator catalog editing survives
   only as **tenant overrides** (wording, extra phrasings), validated against
   the registry — never as a second list of screens.
2. **Explicit command → open immediately** ("open / show / take me to X").
   **Location question → say where + offer** ("where can I see X?", "how do I
   find X?"); open only after the user says yes.
3. **LiveKit is out of scope.** It is not in use; it stays as a dormant backup
   and is not ported. Its navigation code is left untouched, not extended.

## Why the current system keeps breaking (analysis 2026-09-24)

Measured in production (`oasis_events`, read-only): 14 navigation dispatches
across ~690 voice sessions in September, none after 2026-09-19 across 125
sessions; one Serbian request ("latest news, open the screen") resolved
confident/high to the shopping cart.

Root causes, each independently enough to break it:

1. **Two catalogs + two stale route lists.** Static TS catalog (225 screens,
   en/de) and DB `nav_catalog` (291 rows / 187 screens, 11 languages) are
   both used inside one request; lookups, the fast path and embeddings read
   only the static one. The manifest sync reads a file that does not exist.
   `SETTINGS.TENANT` → `/settings/tenant` has no SPA route.
2. **Relative scoring.** The slow path normalises keyword scores so the top
   hit is always 100 → weak hits pass HIGH/MEDIUM. VTID-04049 then made
   zero-keyword semantic hits ask instead of act. Too eager and too timid at
   once.
3. **Six redirect builders with different gates.** `navigate`,
   `navigate_to_screen`, two turn-complete fallbacks, two "yes"-continuation
   paths (which skip auth/role/viewport/params checks), plus LiveKit.
4. **`is_mobile` never reaches navigation** on the orb-live path (not in the
   widget start payload; context updates write a different field).
5. **The conversation cannot happen.** The redirect is dispatched at
   tool-call time and the one-way `navigationDispatched` latch then drops all
   model audio and mic input for the rest of the session — including
   overlays and `keep_orb_open`. The prompt has three conflicting rules and
   names tools that do not exist (`navigate_to`, `get_route`).
6. **Silent client failures.** Five overlay events have no listener; the
   settings deep-link fires after a fixed 50 ms; no navigation result is
   reported back; the server sets `current_route` before the client acted,
   which produces false `already_there` refusals.
7. **Sessions without navigation.** Cascade languages (ru/pl/tr/zh/ar, sr via
   Fish) get no navigation tools; work surfaces lose `navigate_to_screen`;
   the admin role has zero catalog entries.

## Target architecture

- **Screen registry** (`vitana-v1/src/navigation/screens.registry.ts`): per
  screen — id, desktop route, mobile route or overlay event, required params,
  roles/auth, what information the screen shows, title + 5–10 example
  phrasings per shipped locale. Generated JSON is shipped to the gateway;
  DB rows hold tenant overrides only.
- **One resolver**: `resolveScreen(utterance, ctx)` →
  `open | offer | clarify | none` with screen, alternatives and a reason.
  Hybrid semantic + lexical with **absolute, calibrated** thresholds, indexes
  the example phrasings, language-aware stopwords/homonyms.
- **Two tools**: `find_screen(query)` (where is it, what it shows, no side
  effect) and `open_screen(screen_id, params)`. The server holds an offered
  screen so "yes" goes through the same `open_screen`.
- **One dispatcher** with every gate, used by every path and every voice
  pipeline (Nova, Vertex bridge, cascade) and every surface.
- **Client owns the route**: the server sends `screen_id + params`; the SPA
  maps it through the registry (it knows mobile vs desktop) and **acks**
  `opened | refused | not_found`. `current_route` updates only on ack; a
  failure is returned to the model so it can say so.
- **Speak, then navigate**; turn-scoped latch; overlays and `keep_orb_open`
  keep the conversation alive.
- **One generated navigation prompt block**, derived from the tool contract.

## Phases

| Phase | Scope |
|---|---|
| 0 — Measure (VTID-04496) | Golden utterance set, resolver-agnostic harness, legacy baseline + ratchet. |
| 1 — Registry | vitana-v1 registry reconciled from both catalogs; CI: route ↔ registry, overlay listener, locale completeness, no hard-coded directive routes. |
| 2 — Resolver + tools + dispatcher | New resolver, `find_screen`/`open_screen`, single dispatcher, behind a flag; telemetry with top picks. |
| 3 — Client | Registry-based route mapping, ack, missing overlay listeners, settings deep-link on readiness. |
| 4 — Conversation | Speak-then-navigate, turn-scoped latch, held offer, new prompt block, tools on cascade and all surfaces. |
| 5 — Rollout | Staging vs baseline, promote, retire legacy tools/catalog/DB scorer. |

## Regression contract

1. **Registry CI** (both repos, every PR): every SPA route registered or
   explicitly excluded; every registry route resolves (not `NotFound`); every
   overlay event has a listener; locale completeness; lint against
   hard-coded directive routes.
2. **Golden set** (`services/gateway/test/nav-golden/`, every PR): utterance →
   screen + outcome across 11 locales; fails on accuracy drop or any
   wrong-screen action. Adding a screen or moving content = add cases in the
   same PR.
3. **Scripted conversation tests** through real handlers + dispatcher with a
   scripted model: where → offer → yes → open → ack; explicit open; clarify;
   missing params; viewport; cascade.
4. **Model-in-the-loop eval** nightly on staging with the real voice model and
   real tool schema.
5. **Client e2e** on the PR preview: every registry screen × mobile/desktop,
   assert URL/overlay (read-only).
6. **Production monitor**: daily dispatch/request ratio, refusal reasons,
   `not_opened` acks; alert on drop.

## Phase 0 baseline (legacy navigator, keyword path, embeddings off)

167 golden cases. Full report:
`docs/validation/VTID-04496/outputs/golden-baseline-report.txt`.

| Slice | n | Reaches right screen | "Which one?" (right option listed) | Silent | Wrong screen | Redirect on small talk |
|---|---|---|---|---|---|---|
| All | 167 | 73 (44%) | 43 | 41 | 3 | 4 of 7 |
| Explicit "open" | 107 | 40 (37%) | 29 | 37 | 1 | – |
| "Where is…" | 53 | 33 opened, 0 offered | 14 | 4 | 2 | – |
| en + de | 117 | 71 (61%) | 36 | 2 | 3 | 4 |
| other 9 locales | 50 | 2 (4%) | 7 | 39 | 0 | 0 |

Production runs with embeddings on, so this is the lower bound of the
legacy system; the production failures (news → cart) come from the DB
scorer + embeddings path and are kept as permanent cases regardless.

## Phase 2 — resolver (VTID-04517), measured 2026-09-24

The resolver is Titan v2 embeddings (512 dimensions) over every registry
title, description and phrasing, in all 11 languages. It is not a hybrid
with a lexical score: a title-word boost was measured and made confident
wrong answers worse (133 → 141 → 159 as the boost grew).

It measures confidence against the best screen on **another page**, because
a page and its own tabs always sit close together. Thresholds were chosen on
the golden set and on leave-one-out over all 5,404 registry phrasings:

| Setting | Value | Why |
|---|---|---|
| Open without asking | top ≥ 0.65 and lead over other pages ≥ 0.2 | 0 wrong screens on the golden set. Leave-one-out wrong-page count: 50 (versus 95 at 0.15 and 184 at 0.1). |
| Offer candidates | score ≥ 0.45, up to 5 | Small talk ("wie spät ist es") stays below it. |

Golden set, with golden sentences held out of the registry (70 of the 167
were copied into it as phrasings): **147 of 160 requests reach the right
screen directly or as the first candidate (legacy: 73)**. It has 0 wrong
screens, 0 small-talk actions and 2 silent cases, both Serbian.
Leave-one-out top-5 recall is 93%. Serbian (76%) and Arabic (83%) are the
weak languages, so that is where the registry needs better phrasings.

Leave-one-out becomes the per-screen contract: a screen must come back in
the top five for at least 60% of its own held-out phrasings. A new screen
that reads like an existing one fails CI until its phrasings say what makes
it different.
