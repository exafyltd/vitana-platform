# VTID-04517 — Navigation rebuild, Phase 2 (part 1): registry resolver

Plan and owner decisions: `docs/navigation-rebuild/PLAN.md`. This part adds
the resolver and its regression tests. **Nothing calls it yet**: the voice
tools and the dispatcher that use it come in the next PR, behind a flag,
staging first. No runtime behaviour changes when this merges.

## What it is

`services/gateway/src/navigation/`:
- `nav-registry.ts`: reads the screen registry the frontend publishes
  (`NAV_REGISTRY_URL`, e.g. `https://preview-aws.vitanaland.com/nav-registry.json`),
  with a bundled snapshot as fallback. An unreachable or invalid live file
  never replaces a good registry.
- `nav-embedder.ts`: Titan Text Embeddings v2 on Bedrock, 512 dimensions.
  Vectors for every bundled registry text ship with the image as int8, so
  startup does not need Bedrock.
- `nav-resolver.ts`: scores each screen by its closest title, description or
  phrasing (11 languages), then returns:
  - `match` when the top score is ≥ 0.65 and leads the best screen on another
    page by ≥ 0.2;
  - otherwise `ambiguous` with up to 5 candidates;
  - `none` below 0.45.
  It filters out disabled screens, screens that need an entity, member-only
  screens for anonymous visitors, the wrong viewport and tenant exclusions.
- `nav-eval.ts`: leave-one-out over every registry phrasing. The same code can
  run on a live gateway against the registry it is actually serving.
- `nav-service.ts`: keeps the registry and index current in the background.
  Returns `unavailable` rather than guessing before the index exists.

## Acceptance criteria

AC-1: The resolver never offers disabled screens, entity-only screens,
member screens to anonymous visitors, screens for the other viewport, or
tenant-excluded screens. It picks the route for the caller's viewport and the
title in the session language.
TEST: services/gateway/test/navigation/nav-resolver.test.ts

AC-2: A screen opens without asking only when it clearly leads every screen on
another page. Near-ties return candidates, and nothing close returns none. The
thresholds are pinned.
TEST: services/gateway/test/navigation/nav-resolver.test.ts

AC-3: The live registry is adopted only when valid. Unreachable or malformed
files keep the snapshot. Stored int8 vectors change no score by more than 0.01.
TEST: services/gateway/test/navigation/nav-resolver.test.ts

AC-4: On the golden set, with every golden sentence held out of the registry:
- no small talk opens or offers a screen;
- no production failure reaches its forbidden screen;
- the resolver beats the legacy navigator on reaching the right screen, on
  wrong screens and on silence;
- it ratchets against `baseline.registry.json`.
TEST: services/gateway/test/nav-golden/nav-golden-registry.test.ts

AC-5: Every voice-reachable screen is found from its own held-out phrasings,
ranking in the top five for at least 60% of them. Confident resolutions to a
different page may not exceed `baseline.loo.json`. This is the per-screen
regression for newly added screens.
TEST: services/gateway/test/nav-golden/nav-registry-loo.test.ts

AC-6: Every bundled registry text and golden sentence has a stored vector, and
the test failure names the regeneration command.
TEST: services/gateway/test/nav-golden/nav-registry-loo.test.ts

## Result (full report: `outputs/registry-resolver-report.txt`)

Golden set, 167 cases (160 navigation requests), golden sentences held out:

| | legacy | registry resolver |
|---|---|---|
| right screen, opened/offered directly | 73 | 88 |
| right screen first in the hand-off list | – | 59 |
| **right screen directly or first** | **73 (44%)** | **147 (92%)** |
| silent | 41 | 2 (both Serbian) |
| wrong screen | 3 | 0 |
| small talk acted on | 4 of 7 | 0 of 7 |

Leave-one-out over 5,404 registry phrasings:
- top-5 recall is 93.3% overall, 99.8% for English and 76% for Serbian (the
  weakest);
- 50 confident resolutions go to another page, mostly look-alike screens,
  e.g. podcasts in Media vs Health education, and Settings › Social vs
  Connectors › Social.

Live Titan check from this session (read-only Bedrock calls):
- a fresh query vector equals the stored one (cosine 1.0000);
- one query takes about 220 ms;
- "wie spät ist es" returns `none`;
- "take me to the place where I can see my blood test results" matches
  `HEALTH.MY_BIOLOGY` (0.85, lead 0.37).

## Known limits

- The 2 silent golden cases and most wrong-page leave-one-out cases are
  Serbian. Serbian needs more and better phrasings (registry data in
  vitana-v1). The ratchet makes sure that fix can only improve the numbers.
- Memory Garden's German phrasings contain "zeig mir meine Erinnerungen",
  which is also the reminders request from the production incident. The
  resolver returns candidates rather than a wrong screen here, but the
  phrasing should move (vitana-v1 follow-up).
- Leave-one-out takes ~35 s of arithmetic on a CI runner (5,400 × 7,600
  dot products of 512 dimensions).

## Part 2 — the voice tools behind NAV_V2_ENABLED

`src/navigation/nav-dispatch.ts`, hooked into the two existing shared voice
tools. They keep their names, because dozens of prompts and tool descriptions
refer to them:

- **`navigate(question, intent)`** — the registry resolver.
  - `intent:"open"` with a clear match opens the screen now.
  - `intent:"where"` with a clear match returns the screen and an instruction
    to answer and offer; nothing opens.
  - A near-tie returns candidates for the model; no match returns "do not
    navigate".
  - A missing `intent` counts as "where", so the tool never opens a screen
    without an explicit request.
- **`navigate_to_screen(screen_id)`** — `openScreen()`, the one place a screen
  opens:
  - known screen (id, retired id or alias);
  - not disabled, and needs no entity;
  - member screens are refused to anonymous visitors;
  - right viewport, and not the page the member is already on;
  - mobile route on mobile, overlays via `?open=<marker>`.
  - An invented id is resolved from the model's stated reason, not
    fuzzy-matched.
- **Fallbacks to the legacy navigator:** role surfaces the registry does not
  cover yet (`/admin`, `/backoffice`, …), screens that need an entity id, and
  a resolver that cannot run.
- **Telemetry:** `orb.navigator.resolved` records the kind, intent, top
  candidates and scores for every request.
- **Staging only:** `AWS-STAGE-DEPLOY-GATEWAY.yml` pins `NAV_V2_ENABLED=true`
  and `NAV_REGISTRY_URL=https://preview-aws.vitanaland.com/nav-registry.json`.
  Production is untouched.

AC-7: With the flag on, an explicit open request with a clear match opens the
screen. A where-question is answered with an offer and opens nothing. A
near-tie hands candidates to the model, small talk never navigates, and every
decision emits `orb.navigator.resolved`.
TEST: services/gateway/test/navigation/nav-dispatch.test.ts

AC-8: `navigate_to_screen` with the flag on enforces every gate in one place:
unknown, disabled and entity-only screens, anonymous visitors, viewport and
already-there. Retired ids map to their replacement, and invented ids resolve
from the model's reason.
TEST: services/gateway/test/navigation/nav-dispatch.test.ts

AC-9: The conversation "where is my diary?" → offer → member says yes → the
model calls `navigate_to_screen` with the offered id ends in exactly one
`orb_directive` on the session transport, and `current_route` is updated.
TEST: services/gateway/test/navigation/nav-dispatch.test.ts

AC-10: With the flag off nothing changes: the `navigate` declaration has no
`intent`, and the legacy paths run as before. Role surfaces stay on the
legacy navigator even with the flag on.
TEST: services/gateway/test/navigation/nav-dispatch.test.ts

AC-11: The flag and registry URL are pinned on staging only, exactly once,
stripped first; production does not declare them.
TEST: services/gateway/test/vtid-04517-staging-nav-v2-pinned.test.ts

OASIS_PROOF: `orb.navigator.resolved` (new topic, `source: nav-dispatch`) will
appear on staging once the pinned flag deploys. Not yet observed.
