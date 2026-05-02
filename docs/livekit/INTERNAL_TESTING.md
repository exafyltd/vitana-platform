# LiveKit Voice Pipeline — Internal Testing Runbook

End-to-end runbook for getting the LiveKit standby pipeline serving real voice traffic for internal testing. Once this is working, operators can flip `Vertex ↔ LiveKit` from Voice Lab and the community app picks up the new pipeline on the next ORB session.

## Prerequisites — what must land before testing

The full delivery is split across these PRs (open at the time of writing). They can merge in any order but Phase 1 of testing requires all of them in `main`:

### Foundation (Wave 1)
- [vitana-platform#1150](https://github.com/exafyltd/vitana-platform/pull/1150) — `voice-pipeline-spec/` + parity scanner CI
- [vitana-platform#1155](https://github.com/exafyltd/vitana-platform/pull/1155) — `services/agents/orb-agent/` Python skeleton
- [vitana-platform#1156](https://github.com/exafyltd/vitana-platform/pull/1156) — Supabase migration (voice_providers + agent_voice_configs tables)
- [vitana-platform#1157](https://github.com/exafyltd/vitana-platform/pull/1157) — gateway orb-livekit route stubs
- [vitana-v1#324](https://github.com/exafyltd/vitana-v1/pull/324) — useLiveKitVoice + useActiveVoiceProvider hooks (skeleton)
- [vitana-platform#1158](https://github.com/exafyltd/vitana-platform/pull/1158) — Voice Lab Active Provider banner + Providers + Agent Config tabs
- [vitana-platform#1159](https://github.com/exafyltd/vitana-platform/pull/1159) — self-hosted LiveKit Terraform
- [vitana-platform#1160](https://github.com/exafyltd/vitana-platform/pull/1160) — EXEC-DEPLOY 5/5 + DEPLOY-ORB-AGENT workflow

### Implementation (Wave 2)
- [vitana-platform#1162](https://github.com/exafyltd/vitana-platform/pull/1162) — gateway real implementations (active-provider, livekit/token, context-bootstrap, voice-config CRUD, /test probes)
- [vitana-platform#1163](https://github.com/exafyltd/vitana-platform/pull/1163) — orb-agent real tool bodies + livekit-agents wiring
- [vitana-v1#327](https://github.com/exafyltd/vitana-v1/pull/327) — useLiveKitVoice real Room.connect
- [vitana-platform#1165](https://github.com/exafyltd/vitana-platform/pull/1165) — Voice Lab Agent Config dropdowns + Save + Test conversation
- [vitana-v1#329](https://github.com/exafyltd/vitana-v1/pull/329) — useOrbVoiceUnified wires VitanaAudioOverlay to active provider

## Operational prerequisites (you, not Claude)

Three things require your sign-off before the LiveKit pipeline can carry traffic:

### 1. LiveKit infrastructure

You have two choices for internal testing:

**Option A — LiveKit Cloud trial (fastest path to internal testing).** Free for development workloads up to a usage cap. Single-line env-var change vs. self-hosted; same SDK. Caveats: per-minute fees if usage grows; only acceptable for internal-team testing.

```bash
# Sign up at https://cloud.livekit.io, create a project, copy the keys.
gcloud secrets create LIVEKIT_URL --replication-policy=automatic
echo -n 'wss://your-project.livekit.cloud' | gcloud secrets versions add LIVEKIT_URL --data-file=-
gcloud secrets create LIVEKIT_API_KEY --replication-policy=automatic
echo -n 'APIxxxxxxxxx' | gcloud secrets versions add LIVEKIT_API_KEY --data-file=-
gcloud secrets create LIVEKIT_API_SECRET --replication-policy=automatic
echo -n 'secret-value' | gcloud secrets versions add LIVEKIT_API_SECRET --data-file=-
```

**Option B — self-hosted LiveKit OSS (production target).** Apply the Terraform from PR #1159:

```bash
cd infra/livekit
terraform init -backend-config=backend.hcl
terraform plan -var-file=examples/dev.tfvars   # ramp single-node, ~$310/mo
terraform apply -var-file=examples/dev.tfvars
# Use the output values to populate the secrets:
terraform output -raw livekit_url   # wss://livekit-dev.vitana.dev
# Then push LIVEKIT_API_KEY and LIVEKIT_API_SECRET that you generated for
# the SFU's keys block in livekit.yaml.
```

### 2. Provider API keys

Internal testing only needs the providers you actually plan to use. The recommended cheap-and-fast trio:

```bash
# Deepgram STT
gcloud secrets create DEEPGRAM_API_KEY --replication-policy=automatic
echo -n 'YOUR_DG_KEY' | gcloud secrets versions add DEEPGRAM_API_KEY --data-file=-

# Anthropic Claude (the LLM)
gcloud secrets create ANTHROPIC_API_KEY --replication-policy=automatic
echo -n 'sk-ant-...' | gcloud secrets versions add ANTHROPIC_API_KEY --data-file=-

# Cartesia TTS
gcloud secrets create CARTESIA_API_KEY --replication-policy=automatic
echo -n 'YOUR_CARTESIA_KEY' | gcloud secrets versions add CARTESIA_API_KEY --data-file=-
```

Other providers (AssemblyAI, ElevenLabs, OpenAI, Rime, Inworld, etc.) are optional — set them only if you want to A/B them via the Voice Lab Agent Config UI.

### 3. Gateway service token

The agent worker authenticates to the gateway with a service token (NOT a user JWT). Mint one with the gateway's existing service-token issuer (or use a long-lived one for the internal-testing window):

```bash
gcloud secrets create GATEWAY_SERVICE_TOKEN --replication-policy=automatic
echo -n 'svc-orb-agent-...' | gcloud secrets versions add GATEWAY_SERVICE_TOKEN --data-file=-
```

## Apply the migration

```bash
# Trigger the manual workflow (RUN-MIGRATION.yml) for the new file:
gh workflow run RUN-MIGRATION.yml \
  -F migration_file=20260507100000_vtid_livekit_foundation_voice_tables.sql
```

After it runs, sanity-check via the Supabase SQL editor:

```sql
SELECT count(*) FROM voice_providers;
-- expect 28 rows
SELECT id, kind, display_name FROM voice_providers ORDER BY kind, id;
```

## Deploy the orb-agent

```bash
gh workflow run DEPLOY-ORB-AGENT.yml -f environment=dev-sandbox
```

The first run takes ~5 minutes (Docker build + Cloud Run revision). Subsequent runs are faster. Watch the run for the smoke-test step that polls `/health` 5 times.

After deploy:

```bash
# Get the service URL and store it as the gateway's ORB_AGENT_URL env var,
# so /api/v1/orb/livekit/health can probe back.
SERVICE_URL=$(gcloud run services describe vitana-orb-agent \
  --region=us-central1 --project=lovable-vitana-vers1 \
  --format='value(status.url)')
echo "$SERVICE_URL"

gcloud run services update gateway \
  --region=us-central1 \
  --update-env-vars="ORB_AGENT_URL=$SERVICE_URL"
```

## Smoke check the gateway-side health

```bash
GATEWAY="https://gateway-q74ibpv6ia-uc.a.run.app"

curl -s "$GATEWAY/api/v1/orb/livekit/health" | jq '.'
# Expect: ok=true, agent_worker_reachable=true, providers.* configured booleans

curl -s "$GATEWAY/api/v1/orb/active-provider" | jq '.'
# Expect: active_provider="vertex" (default until you flip)

curl -s "$GATEWAY/api/v1/voice-providers" | jq '.providers | length'
# Expect: 28
```

## Configure the orb-agent's voice trio

Open Voice Lab → **Agent Config** tab. Click `orb-agent`. Pick:
- STT: Deepgram, Nova 3
- LLM: Anthropic Claude, claude-sonnet-4-6
- TTS: Cartesia, Sonic 3

Click **Save**. Toast says "Saved." A row in `agent_voice_config_changes` is auto-written by the migration trigger.

(Optional) Click **Test conversation** → returns a 5-minute LiveKit token + URL. Paste these into a tester / playground client (e.g. https://livekit.io/connection-tester) to audition the lineup before flipping production.

## Flip the active provider

Voice Lab → **Active Voice Provider** banner at the top → click **Flip to LiveKit** → confirm. The 60-minute anti-flap cooldown starts; the button greys out for an hour.

```bash
# Or via the API directly (requires exafy_admin role):
curl -X POST "$GATEWAY/api/v1/orb/active-provider" \
  -H "Authorization: Bearer $YOUR_ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"provider": "livekit", "reason": "internal testing"}'
```

## Test as a real user

Per `memory/feedback_test_as_real_user.md`:

```bash
# Mint a magic-link login for the e2e tester:
# (admin → users → e2e-test@vitana.dev → generate_link)
# Open the link in a clean browser window → vitanaland loads.
```

Click ORB. The widget loads, `useActiveVoiceProvider` returns `livekit`, `useOrbVoiceUnified` picks `useLiveKitVoice`, the Room connects. You hear Cartesia's voice (Sonic 3). Speak. Deepgram streams the transcript. Claude responds. Tools fire as gateway HTTP calls (verify in OASIS Events).

## Verifying tool calls work

In a second tab, open Voice Lab → ORB Live tab. Within 1-2 seconds of a tool call you should see:

```
livekit.session.start  { stt: deepgram, llm: anthropic, tts: cartesia, ... }
livekit.tool.executed   { tool: search_memory, latency_ms: 230 }
livekit.session.stop
```

If nothing fires, verify:
1. The agent worker is reachable: `curl $SERVICE_URL/health` returns `ok: true`.
2. The gateway has `ORB_AGENT_URL` set.
3. The agent's logs (Cloud Run logs) show `livekit_worker.starting`, `orb_agent.ready`.

## Flip back

Same banner → "Flip to Vertex" — but only after the 60-minute cooldown elapses. Override is via direct API with `reason="rollback"`. The community app picks up Vertex on the next ORB session; in-flight LiveKit sessions drain naturally.

## Roll forward, roll back, repeat

This is the whole point of the parallel architecture. Both pipelines stay live; flipping is a config change, not a deploy. Internal testing should exercise:

1. Flip Vertex → LiveKit, verify a session works.
2. Change the agent's TTS from Cartesia to ElevenLabs (Voice Lab → Agent Config → Save). Next session uses ElevenLabs.
3. Change the LLM from Claude to GPT-4o. Next session uses GPT-4o (with whichever provider strict-tool-schema semantics you've configured per provider's options_schema).
4. Flip back to Vertex. Verify the existing Vertex pipeline still works identically.
5. Trigger a multi-specialist handoff: ORB session → "I want to report a bug" → `report_to_specialist` fires → Devon's voice takes over. Verify both `voice.handoff.start` and `voice.handoff.complete` events.

## Observability

| Surface | URL | What you see |
|---|---|---|
| Voice Lab — ORB Live | /command-hub/diagnostics/voice-lab/ | Live session list, transcripts, tool calls |
| Voice Lab — Providers | /command-hub/diagnostics/voice-lab/providers/ | Registry table with per-provider model + fallback chain |
| Voice Lab — Agent Config | /command-hub/diagnostics/voice-lab/agent-config/ | Per-agent dropdowns + save + test |
| OASIS Events | /command-hub/oasis/events | Stream of voice.* / livekit.* / orb.* events |
| Agents Registry | /command-hub/autonomy/* | orb-agent self-reported heartbeat |
| Cloud Run logs | console.cloud.google.com | Agent worker stdout (structured logs) |

## Known limitations during internal testing

- **`/orb/context-bootstrap` is the minimal-viable port** — full inline builder from `orb-live.ts:11768+` (memory garden + admin briefing + profiler + last session info) lands in a follow-up PR. Prompts will be smaller than the Vertex side until then. Not a behaviour blocker, just a quality difference.
- **Mobile (Appilix WebView)** — WebRTC compatibility unverified. Phase 0 of the plan calls for a 4-scenario empirical spike. Until that lands, default mobile to Vertex by setting `VOICE_ACTIVE_PROVIDER=vertex` (or just don't flip globally).
- **Voice-while-screen-locked** on iOS WebView is a known LiveKit issue (`client-sdk-js#1116`). Test it explicitly.
- **System-instruction golden-file diff** between the TS Vertex builder and the Python LiveKit port is not yet enforced in CI. Until it is, the two prompts may differ in subtle ways. Treat any user-reported "Vitana sounds different on LiveKit" as an instructions.py drift signal.

## When something doesn't work

- **`POST /orb/livekit/token` returns 503** — `active_provider` is still `vertex`. Flip in Voice Lab.
- **Token mints but Room.connect times out** — LiveKit URL/keys mismatch. Verify with `livekit-cli load-test` from outside GCP.
- **Room joins but no agent** — orb-agent worker isn't dispatching. Check Cloud Run logs for `livekit_worker.starting`. Common cause: `LIVEKIT_URL` env var not set on the agent's Cloud Run revision.
- **Agent connects but no audio** — provider keys missing. Check `/orb/livekit/health.providers.*` — the keys you configured for the cascade must show `_configured: true`.
- **Tool calls hang** — agent worker can't reach gateway. Check `GATEWAY_URL` + `GATEWAY_SERVICE_TOKEN` on the agent's revision.

For deeper debugging, the parity scanner CI run on every voice-surface PR catches drift between the Vertex and LiveKit surfaces before merge. If a tool exists on Vertex but not LiveKit (or vice versa), the PR comment will flag it.
