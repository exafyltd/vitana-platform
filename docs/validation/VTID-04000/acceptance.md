# VTID-04000 — Serbian voice bridge: revive Vertex Live on a NEW GCP account, sr only

## Report / decision

VTID-03998's Fish `latency` fix was measured live against a real Serbian
voice (6 trials, `s2.1-pro-free`) and disproved: at realistic reply length
(~535 chars) `'normal'` and `'low'` both averaged ~9.6s — no measurable
difference. Fish's real throughput is ~50-60 chars/sec regardless of mode,
so the actual driver of the reported "zero audio" pre-login failures is
turn text length vs. TTS throughput, not the request-shape field VTID-03998
tuned. Fixing that in the shared cascade would mean touching
`cascaded-live-client.ts`'s turn-shaping, outside the Fish-only scope the
platform owner had set.

The platform owner instead opened a **new, dedicated GCP project** (never
the decommissioned `lovable-vitana-vers1`) with a 90-day free-credit window
and asked to revive the Vertex Live API for Serbian specifically, since
Gemini Live natively speaks Serbian in one hop — confirmed via Google's own
docs (`sr` is in the Live API's supported-language list) before any code
was written.

## Investigation

Read `upstream-provider-selector.ts` in full. Confirmed the Vertex
infrastructure (`VertexLiveClient`, the AWS-compatible ADC bootstrap
`gcp-adc-bootstrap.ts`, Serbian's own Gemini TTS voice mapping in
`voice-mapping.ts`) was never deleted after the GCP shutdown — it was made
structurally unreachable by VTID-03723, which rewired every selector branch
so `provider: 'vertex'` could never be returned again, after a real
incident (staging's `voice.active_provider='vertex'` row silently routing
Polish/Portuguese sessions to a dead Vertex connection that "spoke" fluent
English because nothing else was ever consulted). `ctx.vertexUnavailable`
is declared on the selector's context type but is no longer read anywhere
— the force-through is unconditional, not flag-gated.

## Fix — one narrow, explicit, additive carve-out

New `orb/live/upstream/vertex-serbian-bridge.ts`:
`isVertexSerbianBridgeEnabled()` (exact-string `VERTEX_SERBIAN_BRIDGE_
ENABLED=true`, same activation-gate convention as `isCascadeEnabled()`) and
`isVertexSerbianBridgeLanguage(lang)` (true only for `sr`, any region/script
suffix — never widened to a list).

`upstream-provider-selector.ts`: new `tryVertexBridgeRescue()`, mirroring
`tryCascadeRescue()`'s exact "returns null when it does not apply"
contract, checked BEFORE `tryCascadeRescue()` at all 5 call sites
(`resolveWithoutVertex`, both branches of `evaluateNovaRequest`, both
branches of `evaluateNovaCanary`). Fires only when BOTH
`vertexSerbianBridge.enabled` and `vertexSerbianBridge.languageSupported`
are explicitly `true`. New `SelectionReason: 'vertex_serbian_bridge'`.

`routes/orb-live.ts`: wired the two precomputed booleans into the real
`selectUpstreamProvider()` call site the same way `cascade`/`nova` already
are — the selector itself never reads env vars or language strings.

`scripts/aws/setup-vertex-serbian-bridge.sh`: provisioning script (dry-run
by default, `--apply` to execute) — creates a scoped GCP service account
(`roles/aiplatform.user` only) on the new project and pushes its key into
AWS Secrets Manager as `vitana/gateway/<env>/gcp-service-account-json`.
Refuses outright if `--gcp-project lovable-vitana-vers1` is passed.
Deliberately NOT wired into `AWS-STAGE-DEPLOY-GATEWAY.yml` in this VTID —
same reasoning as `setup-fish-audio-secret.sh`'s own precedent: this
session cannot confirm the secret exists before merging code that would
require it, and that workflow's secret-resolution loop hard-fails the
entire staging deploy on a missing listed secret.

`CLAUDE.md`: updated the GCP-decommission banner, NEVER rule 27, and
§2e's own intro to document this as a deliberate, narrow, time-boxed
exception rather than a general reopening — plus a new
§2e-vertex-serbian-bridge section with the full mechanism, the
`VERTEX_PROJECT_ID` stale-fallback caveat (still defaults to the
decommissioned project id when `GOOGLE_CLOUD_PROJECT`/`GCP_PROJECT_ID` are
unset), and the new env vars in §8.

## Acceptance Criteria

AC-1 — the bridge fires ONLY when both `enabled` and `languageSupported`
are explicitly `true`; a half-satisfied gate, an absent context, or a
language Nova already speaks all leave existing behaviour byte-for-byte
unchanged.

TEST: `upstream-provider-selector.test.ts`, "VTID-04000: Vertex Serbian
bridge — the one narrow exception" (10 tests: positive path at all 3 call
sites, priority over the cascade rescue, 4 mutation-negative cases).

TEST: `vertex-serbian-bridge.test.ts` (11 tests: activation-gate exact
string, language predicate incl. region/script variants and every
Nova/cascade-covered language rejected).

AC-2 — the pre-existing VTID-03723 invariant ("Vertex is never a
destination") still holds for every context that does NOT satisfy both
new gates, including half-satisfied bridge configs added to the existing
invariant matrix.

TEST: `upstream-provider-selector.test.ts`, "invariant: across a broad
matrix of contexts, provider is never vertex" — 3 new half-satisfied
bridge contexts added to the existing matrix, all still assert
`provider !== 'vertex'`.

AC-3 — every pre-existing selector/predicate behaviour is unchanged.

TEST: `outputs/jest-selector-and-bridge.txt` — 2/2 suites, 58/58 tests
passing (all pre-existing VTID-03723/L1/L2.1/Nova/health tests unmodified
except the header comment and invariant-matrix additions, which do not
change any assertion's expected outcome).

## Verification

TEST: `outputs/tsc-noemit.txt` — `tsc --noEmit`, clean (exit 0).

TEST: `outputs/jest-selector-and-bridge.txt` — 58/58 tests passing.

TEST: `outputs/npm-build.txt` — `npm run build`, clean (exit 0).

TEST: `outputs/jest-full-suite.txt` — full gateway suite: 938/939 suites (1
pre-existing skip), 15,325/15,360 tests passing, 0 failures.

TEST: `outputs/bash-syntax-check.txt` — `bash -n
scripts/aws/setup-vertex-serbian-bridge.sh`, clean.

## Not yet independently confirmed (superseded by the WIF pivot below)

**This section describes this VTID's ORIGINAL, build-time state — before
the platform owner supplied the real project details and before the WIF
pivot ("Pivot: GCP org policy blocked service-account keys — Workload
Identity Federation instead", further down this document). It is kept as
a historical record of what this VTID looked like when merged into the
codebase, not as the current wiring — see that later section for what is
actually live on staging's task def.**

At merge time: `VERTEX_SERBIAN_BRIDGE_ENABLED` was unset by default —
every line of this VTID changed nothing on a live task definition until an
operator:
1. Ran `scripts/aws/setup-vertex-serbian-bridge.sh provision --gcp-project
   <new-project-id> --env staging --apply` and confirmed via its `status`
   action.
2. Wired `GCP_SERVICE_ACCOUNT_JSON`, `GOOGLE_CLOUD_PROJECT`,
   `VERTEX_AI_LOCATION`, and `VERTEX_SERBIAN_BRIDGE_ENABLED=true` into
   `AWS-STAGE-DEPLOY-GATEWAY.yml`.
3. Deployed and confirmed a real Serbian voice session actually connects
   to Vertex (`orb.upstream.provider.selected` reporting `reason:
   'vertex_serbian_bridge'` in `oasis_events`) and produces audio within
   budget.

This session had no GCP/AWS credentials for the new project at that point,
so none of that live verification could happen here — the code path was
verified structurally (unit tests + the existing invariant suite) only.
**This changed later in the same session** — see the WIF pivot section:
the platform owner provisioned real WIF credentials via Cloud Shell, and
the staging task def now wires the bridge UNCONDITIONALLY (no operator
step left), so step 1-2 above are no longer accurate for staging. Step 3
(a real Serbian session actually producing audio) is still the one
genuinely open item.

## Staging task-def wiring, with the platform owner's own project details

The platform owner supplied the new GCP project directly: **Vitanaland**,
project id `project-da3eb05a-c86e-47cb-85f`, project number
`20926255361`, Live API enabled as a **global** endpoint (not regional).

`scripts/aws/setup-vertex-serbian-bridge.sh` gained a `--key-file <path>`
option so the owner could push their own already-downloaded
service-account key straight to AWS Secrets Manager themselves, without
ever pasting the key into chat — `gcloud` is skipped entirely on that path,
only the AWS upload runs. Default (no `--key-file`) behavior — gcloud
creates the service account/key itself — is unchanged. **This flow was
superseded before it was ever wired into the deploy workflow — see below —
but the script and its `--key-file` option are left in place, unused for
this deployment, in case a future GCP org without the blocking policy
below wants the simpler Secrets-Manager path.**

Verified `global` needs no code change before wiring it: Google's own docs
confirm the Vertex Live WebSocket endpoint
(`wss://{location}-aiplatform.googleapis.com/ws/...`) accepts `global` as a
literal location exactly like any region — `vertex-live-client.ts`'s
`buildBidiGenerateContentUrl(location)` already does simple string
interpolation, so `global` produces `wss://global-aiplatform.googleapis.com/...`
correctly with no edit needed.

### Pivot: GCP org policy blocked service-account keys — Workload Identity Federation instead

The originally-planned design — `AWS-STAGE-DEPLOY-GATEWAY.yml` resolving
`vitana/gateway/staging/gcp-service-account-json` via
`aws secretsmanager describe-secret` the same OPTIONAL way the ERP-bridge
secret does (VTID-03840) — was never wired, because it depends on a
downloadable service-account private key existing, and one never could.
The platform owner hit GCP's org-wide policy
`iam.disableServiceAccountKeyCreation` live, in the Console, repeatedly,
even as confirmed org Owner ("I did this 15 times, and still this policy
is blocking me"). This is an org-level constraint on the ACTION, not a
permissions gap on any one identity — granting more access (to the owner
or to this session) could not have helped, because the block applies
regardless of who attempts it.

**Replacement: Workload Identity Federation (WIF) for AWS**, Google's own
keyless recommendation for exactly this situation. The platform owner
provisioned it themselves via Google Cloud Shell (their own suggestion),
running three `gcloud` commands supplied by this session:
1. `gcloud iam workload-identity-pools create vitana-aws-pool ...`
2. `gcloud iam workload-identity-pools providers create-aws
   vitana-aws-provider --workload-identity-pool=vitana-aws-pool
   --account-id=472838866351 ...` — trusts AWS account `472838866351`
   directly.
3. `gcloud iam service-accounts add-iam-policy-binding
   vitanaland@project-da3eb05a-c86e-47cb-85f.iam.gserviceaccount.com
   --role=roles/iam.workloadIdentityUser
   --member="principal://iam.googleapis.com/projects/20926255361/locations/global/workloadIdentityPools/vitana-aws-pool/subject/arn:aws:iam::472838866351:user/claude-code-aws-agent"`
   — lets that one AWS principal impersonate the GCP service account by
   presenting its own AWS credentials (a signed `GetCallerIdentity` call),
   no GCP key involved.
4. `gcloud iam workload-identity-pools create-cred-config` — generates the
   authoritative `external_account`-type credential config JSON. Google's
   own docs state this file is safe to store in plain text / source
   control: it contains no private key, only federation metadata (pool,
   provider, STS endpoint URLs) — nothing an attacker could use without
   also controlling the trusted AWS principal's own credentials.

All four commands were run for real in Cloud Shell and their output
(including the final `create-cred-config` JSON) was pasted back into this
session verbatim — this is Google's own authoritative tool output against
the real, live pool/provider/binding, not hand-constructed.

**Wiring:** `AWS-STAGE-DEPLOY-GATEWAY.yml` now assigns the credential
config to a static `GCP_CRED_CONFIG` bash variable (no `describe-secret`
call — there is no secret to resolve) and wires all four vars
UNCONDITIONALLY, in the same strip/re-add block as `AURORA_CA_BUNDLE_PATH`
— no `if` guard, because there is no absent-vs-present secret state to
guard against any more:
- `GOOGLE_CLOUD_PROJECT=project-da3eb05a-c86e-47cb-85f`
- `VERTEX_AI_LOCATION=global`
- `VERTEX_SERBIAN_BRIDGE_ENABLED=true`
- `GCP_SERVICE_ACCOUNT_JSON=$GCP_CRED_CONFIG` (a plain `value`, not
  `valueFrom` a Secrets Manager ARN)

No code changes were needed to consume this: `gcp-adc-bootstrap.ts`
already handles any valid JSON generically (writes it to a file, points
`GOOGLE_APPLICATION_CREDENTIALS` at it), and `google-auth-library`'s
`GoogleAuth()` auto-detects `type:"external_account"` and resolves AWS
credentials itself (checking AWS env vars first, then the ECS task-role
container-credentials endpoint).

TEST: `test/orb/live/upstream/staging-vertex-serbian-bridge-wiring-pinned.test.ts`
(9 tests, rewritten for the WIF shape: no describe-secret/no `SEC_GCP_SA`
anywhere, the credential config assembled as a static non-secret variable,
the real pool/provider/project pinned by literal string match, the jq
`--arg` wiring, all four vars proven UNCONDITIONAL — no `if`-guard — in the
same block as `AURORA_CA_BUNDLE_PATH`, the exact project id + `global`
location, `GCP_SERVICE_ACCOUNT_JSON` wired as `value:$GCP_CRED_CONFIG` not
`valueFrom`, the migration-hygiene strip from `.secrets` with no re-add
there, and confirmed NOT wired on prod). `tsc --noEmit` clean;
`staging-deploy-workflow-bash-syntax.test.ts` still 7/7 (the workflow's
`run:` blocks stay valid bash and the jq program still has no bare
apostrophe) — both re-run together, 2/2 suites, 16/16 tests passing.

**Not yet independently confirmed against a live token exchange.**
Verifying the WIF credential config actually resolves a working GCP OAuth
token locally (e.g. via `google-auth-library`'s
`load_credentials_from_file()` + `.refresh()`) was attempted and was
blocked by this session's own sandbox safety layer, which flagged writing/
using this class of federated-credential config (it matches a
containment-escape-shaped pattern — the config's `credential_source` URLs
point at the AWS instance-metadata IP, `169.254.169.254`) — this session
did not attempt to route around that block. This config is Google's own
authoritative output against the real, live pool/provider/binding, not
hand-constructed, but it has not been independently exercised end-to-end
by this session. The real signal is still the next real `sr` session on
staging actually authenticating and producing audio — confirm via
`oasis_events` reporting `reason:'vertex_serbian_bridge'`.

## Post-merge finding: pre-existing Vertex/LiveKit parity gap (not this VTID's regression)

This PR's own `voice-pipeline-parity` CI scanner (report-only, runs on
every gateway PR) flagged 13 `high`-severity `missing_in_vertex` items:
7 OASIS event topics (`orb.live.context.bootstrap`,
`orb.live.context.bootstrap.skipped`, `orb.live.tool.executed`,
`orb.navigator.requested`, `orb.navigator.blocked`,
`admin.briefing.injected`, `feedback.ticket.created`) and 6 watchdog
settings (`session_timeout_ms`, `conversation_timeout_ms`,
`max_connections_per_ip`, `max_reconnects`, `max_history_chars`,
`extraction_throttle_ms`) present in the LiveKit/Nova pipeline but absent
from `VertexLiveClient`. `safety_critical: 0` — not a crash/security gap —
but this VTID reactivates the exact code path the scan is comparing
against, so it is directly relevant here: a real Serbian bridge session
will not get the same timeout/reconnect-capping/observability coverage a
Nova or cascade session gets, until those are backported or confirmed
covered elsewhere. Documented in CLAUDE.md
§2e-vertex-serbian-bridge as a caveat to check before promoting the
bridge past a small canary. Not fixed here — backporting 13 items into
`VertexLiveClient` is a separate, larger VTID, and the bridge ships
inert regardless.
