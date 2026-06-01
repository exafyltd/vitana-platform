# Track B runbook — release the 3 false `model_under_responds` quarantines

**Status:** prepared, NOT yet executed. Track B is a **governed production state
change** and intentionally was not run from the handoff container because:

1. No gateway/admin auth token was available there.
2. The deployed gateway host was outside that container's network allowlist
   (`403 Host not in allowlist`), same block that stopped the Supabase REST path.
3. CLAUDE.md forbids substituting a raw DB write to bypass the governed endpoint.

## Run AFTER Track A is deployed (ordering matters)

Releasing the quarantines while the unfixed classifier is still live just lets
it re-quarantine the same class within `failed_fix_threshold` (4) failed fixes.
So the sequence is: **merge → deploy Track A (gateway) → confirm `fwd_ratio`
pulls live sessions below the ≥5 threshold → then release.**

## The 3 rows to release (validated 2026-06-01)

| class | signature (`body.signature`) |
|-------|------------------------------|
| `voice.model_under_responds` | `model_under_responds_r5to10` |
| `voice.model_under_responds` | `model_under_responds_r10to20` |
| `voice.model_under_responds` | `model_under_responds_r20to100` |

> Note: the endpoint reads `body.signature` (NOT `normalized_signature` as an
> earlier handoff draft said). It moves `quarantined → probation` (72h, halved
> thresholds, auto-expires to `released`). Each release clears one critical (+15).

## Auth

`POST /api/v1/voice-lab/healing/quarantine/release` is below
`router.use(requireAuth)` → needs a **Supabase user JWT** (`auth-supabase-jwt`
middleware), i.e. an authenticated gateway session token. NOT the Supabase
service-role key, and NOT an unauthenticated call.

## Commands (fill in `$GATEWAY` and `$JWT`)

```bash
GATEWAY="https://gateway-86804897789.us-central1.run.app"
JWT="<supabase user access_token>"

for sig in model_under_responds_r5to10 model_under_responds_r10to20 model_under_responds_r20to100; do
  echo "releasing $sig ..."
  curl -sS -X POST "$GATEWAY/api/v1/voice-lab/healing/quarantine/release" \
    -H "Authorization: Bearer $JWT" \
    -H "Content-Type: application/json" \
    -d "{\"class\":\"voice.model_under_responds\",\"signature\":\"$sig\",\"reason\":\"track-a-forwarded-counter-shipped\"}"
  echo
done
```

Expected success per row: `{"ok":true,"new_status":"probation","probation_until":"<+72h>"}`.

## Verify (read-only, via Supabase MCP `execute_sql` or PostgREST)

```sql
select class, normalized_signature, status, probation_until
from voice_healing_quarantine
where class = 'voice.model_under_responds'
order by quarantined_at desc;
```

All three should read `status='probation'` with a `probation_until` ~72h out.
Then re-check the cockpit quality score — each released critical is +15.
