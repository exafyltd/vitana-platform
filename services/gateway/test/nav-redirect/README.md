# Voice redirect suite (VTID-04607)

Fifty things members say when they want Vitana to open a screen, and the
screen that must open. It is the regression gate for voice navigation: run
it whenever a screen, a popup, a phrasing, the resolver or the navigation
prompt changes.

| File | What it is |
|---|---|
| `redirect-cases.ts` | The 50 cases. English, German and six more languages; pages, tabs, popups, one mobile session. |
| `redirect-harness.ts` | Runs one case through the real `navigate` tool and grades it (shared by CI and the live runner). |
| `nav-redirect-suite.test.ts` | The CI gate. |
| `baseline.redirect.json` | Which cases open on their own today (the ratchet). |
| `run-live.ts` | The same cases live: real Titan, a deployment's registry, and real Nova Sonic speech. |

## The three layers

**1. CI — `npm run test:nav-redirect`** (no network, runs in the gateway Jest job)

Each case goes through the real `navigate` tool (`NAV_V2_ENABLED`) with the
bundled registry snapshot and its stored Titan vectors. A case passes when:

- the expected screen **opens** — with the right route for the device, a
  popup sent as a popup, and the directive waiting for Vitana to finish
  speaking; or
- it is **handed off** — no screen was certain enough on its own, and the
  expected screen is first in the list the voice model is told to open.

Nothing may open, or be put first, that is not in the case's `expect` list.
A case that opens on its own today may not fall back to a hand-off
(`baseline.redirect.json`). The suite also checks that every expected id
exists in the registry and can be opened by voice, so a renamed or removed
screen fails here until the case is updated.

**2. Live resolver** — the registry a deployment serves, real Titan

```bash
BEDROCK_ROLE_ARN=local LAYER=resolver \
  REGISTRY_URL=https://preview-aws.vitanaland.com/nav-registry.json \
  npx tsx test/nav-redirect/run-live.ts
```

**3. Live voice** — the model has to call the tools itself

```bash
BEDROCK_ROLE_ARN=local LAYER=voice npx tsx test/nav-redirect/run-live.ts
```

English and German are spoken by Polly to Nova Sonic with the production
system prompt and tool catalog. The cascade languages (es, fr, pt, pl, ru,
tr, zh, ar) go through `runCascadeModelTurn`, the same function the live
cascade runs (speech-to-text is not exercised). Serbian runs on the Vertex
bridge, which the runner never calls; it is reported as not covered. The
first screen a turn dispatches is the one graded, exactly as the live
session's per-turn guard keeps it.

The live runner writes nothing: Supabase/OASIS point at a dead local port
and only the three navigation tools execute. It needs AWS credentials for
Bedrock (Titan, Nova Sonic) and Polly. `CASES=R01,R07` runs a subset;
`OUT=<file>` sets the JSON report path.

## When you add a screen or a popup

1. Add it to the registry in `exafyltd/vitana-v1`
   (`src/navigation/registry/`) with real member phrasings.
2. If members will ask for it by name, add a case to `redirect-cases.ts`,
   worded the way a member would say it — not copied from the registry.
3. Refresh the snapshot and vectors:
   copy the app build's `public/nav-registry.json` to
   `src/navigation/data/nav-registry.snapshot.json`, then
   `BEDROCK_ROLE_ARN=local npx tsx test/nav-golden/build-embeddings.ts`.
4. `npm run test:nav-redirect`. If a case moved from open to hand-off on
   purpose, regenerate the ratchet with
   `NAV_REDIRECT_WRITE_BASELINE=1 npx jest test/nav-redirect`.
5. Before shipping a prompt or resolver change, run the live voice layer.

A failing case is a finding. Fix the registry data or the code; do not
reword the case until it passes.
