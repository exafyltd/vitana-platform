# VTID-04629 — "Where can I make a post?" opens the post composer

VTID: VTID-04629
VALIDATION_PROFILE: gateway_backend

## Production failure (read-only log review, 2026-09-26)

A member asked Vitana, by voice on mobile, where to make a post for the community.

1. The request was ambiguous; the model took the member to the Following tab of the community feed.
2. After a reconnect, the model called `navigate_to_screen` with an id it made up (`COMM.NEWSFEED`).
   The fallback resolved the words "COMM NEWSFEED" to no screen, and Vitana said she could not open it.
3. No screen in the registry stood for writing a post.

## Acceptance

- AC-1: "where can I make a post / how do I share a post / show me where I can post" (en, de, es) reaches HOME.CREATE_POST (`/home?compose=1`, opens the composer).
  TEST: services/gateway/test/nav-redirect/nav-redirect-suite.test.ts (R51–R56)
- AC-2: "Öffne den Newsfeed" from another screen opens the Home news feed.
  TEST: services/gateway/test/nav-redirect/nav-redirect-suite.test.ts (R57, P05)
- AC-3: an invented screen id whose last part names a real screen (`COMM.NEWSFEED`, `SOCIAL.CREATE_POST`, `HOME.NEWSFEED`) still opens that screen; the member's own words are used when the id matches nothing.
  TEST: services/gateway/test/nav-redirect/nav-redirect-suite.test.ts (I01–I03)
- AC-4: no existing case regresses (ratchet baseline, golden set).
  TEST: services/gateway/test/nav-golden
- AC-5: the live voice run (Polly speech → Nova Sonic, cascade for es) opens the composer for the post cases, including the offer → "ja bitte" follow-up.
  Evidence: outputs/voice-post-cases.json — 9 of 10 open the right screen. R52 ("How can I share a post…"): Nova answered from knowledge search and did not navigate, even after "yes please". Model behaviour, not the resolver (CI resolves R52 correctly).

## Staging

`staging-tests.json` runs the redirect suite and the navigation/golden suites. The registry data ships from exafyltd/vitana-v1 (`/nav-registry.json`), which the gateway fetches at start.
